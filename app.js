// V7.7.28 ACCESS AUTHORITY CONSOLIDATED
import express from 'express';
import 'dotenv/config';
import pg from 'pg';
import http from 'node:http';
import fs from 'node:fs/promises';

const { Pool } = pg;

const converterHealth = { checked:false, tiff_pdf:false, access_excel:false, errors:{} };
async function checkConverterHealth(){
  const errors={}; let tiff=false, access=false;
  try{ await import('sharp'); await import('pdf-lib'); tiff=true; }catch(e){ errors.tiff_pdf=String(e?.message||e).slice(0,300); }
  try{ await import('mdb-reader'); await import('xlsx'); access=true; }catch(e){ errors.access_excel=String(e?.message||e).slice(0,300); }
  Object.assign(converterHealth,{checked:true,tiff_pdf:tiff,access_excel:access,errors});
  console.log('[CONVERTER HEALTH]', JSON.stringify(converterHealth));
  return converterHealth;
}
// V6.1 ephemeral source cache: conversion/retry convenience without permanent file storage.
// Buffers expire automatically and are never written to PostgreSQL.
const recentSourceCache = new Map();
// Latest convertible upload is tracked per approved employee as soon as the WhatsApp
// document message is received. This prevents a later `PDF chey` / `Excel chey`
// command from accidentally selecting an older cached/database file while the newest
// upload is still being indexed in the background.
const latestConvertibleSource = new Map();
// Per-employee upload sequence. Each background ingestion keeps its own immutable source context.
// A later upload can never make an earlier job masquerade as the current file.
const latestUploadSession = new Map();
// V7 file-action gate: document uploads wait for an explicit user action before AI indexing/storage.
const pendingFileAction = new Map();
function setPendingFileAction(employeeNumber, from, msg, meta){ pendingFileAction.set(String(employeeNumber),{from,msg,meta,receivedAt:Date.now(),expiresAt:Date.now()+SOURCE_CACHE_TTL_MS}); }
function getPendingFileAction(employeeNumber){ const k=String(employeeNumber),v=pendingFileAction.get(k); if(!v||v.expiresAt<Date.now()){pendingFileAction.delete(k);return null;} return v; }
function clearPendingFileAction(employeeNumber){ pendingFileAction.delete(String(employeeNumber)); }
function beginUploadSession(employeeNumber, mediaId, name){
  const key=String(employeeNumber), seq=(latestUploadSession.get(key)?.seq||0)+1;
  const v={seq,mediaId:String(mediaId),name:String(name||'file'),receivedAt:Date.now()};
  latestUploadSession.set(key,v); return v;
}
function uploadCompletionPrefix(employeeNumber, session){
  const latest=latestUploadSession.get(String(employeeNumber));
  return latest && latest.seq!==session.seq ? `🕘 Earlier upload completed — ${session.name}\n` : `📄 Source: ${session.name}\n`;
}
const SOURCE_CACHE_TTL_MS = 30 * 60 * 1000;
function rememberLatestConvertible(employeeNumber, mediaId, payload){
  const key=String(employeeNumber);
  latestConvertibleSource.set(key,{...payload,mediaId:String(mediaId),employeeNumber:key,receivedAt:Date.now(),expiresAt:Date.now()+SOURCE_CACHE_TTL_MS});
}
function latestConvertible(employeeNumber, kind){
  const key=String(employeeNumber),v=latestConvertibleSource.get(key);
  if(!v || v.expiresAt<Date.now()){latestConvertibleSource.delete(key);return null;}
  const name=String(v.name||'').toLowerCase(),mime=String(v.mime||'').toLowerCase();
  if(kind==='tiff' && !(mime.includes('tiff') || /\.tiff?$/.test(name))) return null;
  if(kind==='access' && !(mime.includes('access') || /\.(mdb|accdb)$/.test(name))) return null;
  return v;
}
function cacheSource(employeeNumber, mediaId, payload){
  recentSourceCache.set(String(mediaId), {...payload, employeeNumber:String(employeeNumber), expiresAt:Date.now()+SOURCE_CACHE_TTL_MS});
  for (const [k,v] of recentSourceCache) if (!v || v.expiresAt < Date.now()) recentSourceCache.delete(k);
}
function cachedSource(mediaId, employeeNumber){
  const v=recentSourceCache.get(String(mediaId));
  if(!v || v.expiresAt<Date.now() || (employeeNumber && String(v.employeeNumber)!==String(employeeNumber))){ recentSourceCache.delete(String(mediaId)); return null; }
  return v;
}
const app = express();
app.use(express.json({ limit: '20mb' }));

// V7.2 memory hygiene: temporary in-process source buffers are short-lived.
setInterval(()=>{
  const now=Date.now();
  for(const [k,v] of recentSourceCache) if(!v || v.expiresAt<now) recentSourceCache.delete(k);
  for(const [k,v] of latestConvertibleSource) if(!v || v.expiresAt<now) latestConvertibleSource.delete(k);
},5*60*1000).unref?.();

const PORT = Number.parseInt(process.env.PORT || '10000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const VERIFY_TOKEN = (process.env.META_VERIFY_TOKEN || '').trim();
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || '';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

const SUPER_ADMIN_NUMBERS = new Set(
  (
    process.env.SUPER_ADMIN_NUMBERS ||
    process.env.SUPER_ADMIN_NUMBER ||
    process.env.OWNER_NUMBERS ||
    process.env.OWNER_NUMBER ||
    ''
  )
    .split(',')
    .map(x => x.replace(/\D/g, ''))
    .filter(Boolean)
);

function isOwner(value='') {
  const n=String(value||'').replace(/\D/g,'');
  return !!n && SUPER_ADMIN_NUMBERS.has(n);
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    })
  : null;

const NA = 'NOT ASSIGNED';

app.use((req, _res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.originalUrl}`);
  next();
});

const isTe = t => /[\u0C00-\u0C7F]/.test(t || '');
const T = (k, te = false) => ({
  register: te
    ? 'దయచేసి నమోదు చేయండి:\nName / Employee Number / Designation / Section / Area'
    : 'Please register:\nName / Employee Number / Designation / Section / Area',
  pending: te ? 'ఆమోదం కోసం పంపబడింది.' : 'Sent for approval.',
  welcome: te ? 'LMMM AI Maintenance కి స్వాగతం.' : 'Welcome to LMMM AI Maintenance.',
  help: te ? 'నేను మీకు ఎలా సహాయం చేయగలను?' : 'How can I help you?',
  notfound: te ? 'కనుగొనబడలేదు.' : 'Not found.',
  exit: te ? 'నిష్క్రమించారు.' : 'Exited.',
  removed: te ? 'మీ నమోదు తొలగించబడింది.' : 'Registration removed.'
}[k]);

async function initDB() {
  if (!pool) {
    console.error('[DATABASE] DATABASE_URL missing');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id BIGSERIAL PRIMARY KEY,
      whatsapp_number TEXT UNIQUE NOT NULL,
      name TEXT,
      employee_number TEXT UNIQUE,
      designation TEXT,
      area_of_working TEXT DEFAULT 'NOT ASSIGNED',
      section_department TEXT DEFAULT 'NOT ASSIGNED',
      responsibility TEXT DEFAULT 'NOT ASSIGNED',
      approval_status TEXT DEFAULT 'pending',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS responsibility TEXT DEFAULT 'NOT ASSIGNED'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_category TEXT DEFAULT 'NOT ASSIGNED'`);

  // V7.7.24: durable staged multi-select state shared by governance and search UX.
  // A selection is only committed when the user taps Apply/Continue.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ui_selection_sessions(
      owner_key TEXT NOT NULL,
      session_key TEXT NOT NULL,
      target_key TEXT NOT NULL DEFAULT '',
      selected JSONB NOT NULL DEFAULT '[]'::jsonb,
      context JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY(owner_key,session_key,target_key)
    )
  `);




  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_assignments(
      id BIGSERIAL PRIMARY KEY,
      employee_number TEXT NOT NULL,
      area TEXT DEFAULT 'NOT ASSIGNED',
      section TEXT DEFAULT 'NOT ASSIGNED',
      responsibility TEXT DEFAULT 'NOT ASSIGNED',
      sub_area TEXT DEFAULT 'NOT ASSIGNED',
      shift TEXT DEFAULT 'NOT ASSIGNED',
      employment_type TEXT DEFAULT 'NOT ASSIGNED',
      is_additional_charge BOOLEAN DEFAULT FALSE,
      active BOOLEAN DEFAULT TRUE,
      valid_from TIMESTAMPTZ DEFAULT now(),
      valid_to TIMESTAMPTZ,
      assigned_by TEXT
    )
  `);

  await pool.query(`ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS job_scope TEXT DEFAULT 'ALL'`);
  await pool.query(`ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS reason TEXT`);
  // V7.7.22 governance compatibility: older production tables may predate these fields.
  // CREATE TABLE IF NOT EXISTS never upgrades an existing table, so migrate every
  // column used by the Employee Control path non-destructively.
  await pool.query(`ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS area TEXT DEFAULT 'NOT ASSIGNED'`);
  await pool.query(`ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS section TEXT DEFAULT 'NOT ASSIGNED'`);
  await pool.query(`ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS responsibility TEXT DEFAULT 'NOT ASSIGNED'`);
  await pool.query(`ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS sub_area TEXT DEFAULT 'NOT ASSIGNED'`);
  await pool.query(`ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS shift TEXT DEFAULT 'NOT ASSIGNED'`);
  await pool.query(`ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS employment_type TEXT DEFAULT 'NOT ASSIGNED'`);
  await pool.query(`ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS is_additional_charge BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`);
  await pool.query(`ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ DEFAULT now()`);
  await pool.query(`ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE user_assignments ADD COLUMN IF NOT EXISTS assigned_by TEXT`);


  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_special_permissions(
      id BIGSERIAL PRIMARY KEY,
      employee_number TEXT NOT NULL,
      permission TEXT NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      granted_by TEXT,
      granted_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(employee_number, permission)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_responsibilities(
      id BIGSERIAL PRIMARY KEY,
      employee_number TEXT NOT NULL,
      responsibility_role TEXT NOT NULL,
      scope_section TEXT DEFAULT 'NOT ASSIGNED',
      scope_area TEXT DEFAULT 'NOT ASSIGNED',
      sub_area TEXT DEFAULT 'NOT ASSIGNED',
      shift TEXT DEFAULT 'NOT ASSIGNED',
      active BOOLEAN DEFAULT TRUE,
      valid_from TIMESTAMPTZ DEFAULT now(),
      valid_to TIMESTAMPTZ,
      assigned_by TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await pool.query(`ALTER TABLE user_responsibilities ADD COLUMN IF NOT EXISTS responsibility_role TEXT`);
  await pool.query(`ALTER TABLE user_responsibilities ADD COLUMN IF NOT EXISTS scope_section TEXT DEFAULT 'NOT ASSIGNED'`);
  await pool.query(`ALTER TABLE user_responsibilities ADD COLUMN IF NOT EXISTS scope_area TEXT DEFAULT 'NOT ASSIGNED'`);
  await pool.query(`ALTER TABLE user_responsibilities ADD COLUMN IF NOT EXISTS sub_area TEXT DEFAULT 'NOT ASSIGNED'`);
  await pool.query(`ALTER TABLE user_responsibilities ADD COLUMN IF NOT EXISTS shift TEXT DEFAULT 'NOT ASSIGNED'`);
  await pool.query(`ALTER TABLE user_responsibilities ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`);
  await pool.query(`ALTER TABLE user_responsibilities ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ DEFAULT now()`);
  await pool.query(`ALTER TABLE user_responsibilities ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE user_responsibilities ADD COLUMN IF NOT EXISTS assigned_by TEXT`);
  await pool.query(`ALTER TABLE user_responsibilities ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS authority_audit(
      id BIGSERIAL PRIMARY KEY,
      employee_number TEXT,
      action TEXT NOT NULL,
      responsibility_role TEXT,
      scope_section TEXT,
      scope_area TEXT,
      performed_by TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  // V7.7.21 legacy-safe audit schema migration. CREATE TABLE IF NOT EXISTS does not
  // add newer columns to an already-existing production table, so add every field
  // used by governance queries explicitly and non-destructively.
  await pool.query(`ALTER TABLE authority_audit ADD COLUMN IF NOT EXISTS employee_number TEXT`);
  await pool.query(`ALTER TABLE authority_audit ADD COLUMN IF NOT EXISTS action TEXT`);
  await pool.query(`ALTER TABLE authority_audit ADD COLUMN IF NOT EXISTS responsibility_role TEXT`);
  await pool.query(`ALTER TABLE authority_audit ADD COLUMN IF NOT EXISTS scope_section TEXT`);
  await pool.query(`ALTER TABLE authority_audit ADD COLUMN IF NOT EXISTS scope_area TEXT`);
  await pool.query(`ALTER TABLE authority_audit ADD COLUMN IF NOT EXISTS performed_by TEXT`);
  await pool.query(`ALTER TABLE authority_audit ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`);
  await pool.query(`ALTER TABLE authority_audit ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '{}'::jsonb`);

  // V7.7.19 governance: explicit role/authority/access overrides and report-grade data quality state.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS operational_role TEXT DEFAULT 'NORMAL_USER'`);
  await pool.query(`ALTER TABLE user_special_permissions ADD COLUMN IF NOT EXISTS permission TEXT`);
  await pool.query(`ALTER TABLE user_special_permissions ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE`);
  await pool.query(`ALTER TABLE user_special_permissions ADD COLUMN IF NOT EXISTS granted_by TEXT`);
  await pool.query(`ALTER TABLE user_special_permissions ADD COLUMN IF NOT EXISTS granted_at TIMESTAMPTZ DEFAULT now()`);
  await pool.query(`ALTER TABLE user_special_permissions ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ DEFAULT now()`);
  await pool.query(`ALTER TABLE user_special_permissions ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE user_special_permissions ADD COLUMN IF NOT EXISTS reason TEXT`);
  await pool.query(`ALTER TABLE user_special_permissions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_authority_grants(
    id BIGSERIAL PRIMARY KEY, employee_number TEXT NOT NULL, authority_code TEXT NOT NULL,
    active BOOLEAN DEFAULT TRUE, valid_from TIMESTAMPTZ DEFAULT now(), valid_to TIMESTAMPTZ,
    reason TEXT, granted_by TEXT, updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(employee_number,authority_code)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS data_quality_review(
    id BIGSERIAL PRIMARY KEY, record_uid TEXT NOT NULL, issue_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'NEEDS_REVIEW', notes TEXT, reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(record_uid,issue_code)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_default_permissions(
    id BIGSERIAL PRIMARY KEY, employee_number TEXT NOT NULL, permission TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'REGISTRATION_HIERARCHY', source_detail TEXT,
    scope_section TEXT, scope_area TEXT, active BOOLEAN DEFAULT TRUE,
    calculated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(employee_number,permission)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_default_permissions_emp ON user_default_permissions(employee_number,active)`);
  // V7.7.31: one authoritative manual access snapshot per employee. Registration defaults remain separate.
  await pool.query(`CREATE TABLE IF NOT EXISTS user_access_override(
    employee_number TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT TRUE,
    permissions JSONB NOT NULL DEFAULT '[]'::jsonb, updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), reason TEXT
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_authority_grants_emp ON user_authority_grants(employee_number,active)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_data_quality_record ON data_quality_review(record_uid,status)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS employee_contacts(
      id BIGSERIAL PRIMARY KEY,
      employee_number TEXT NOT NULL UNIQUE,
      max_number TEXT,
      company_email TEXT,
      entered_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS emergency_contacts(
      id BIGSERIAL PRIMARY KEY,
      contact_name TEXT NOT NULL,
      max_number TEXT NOT NULL,
      notes TEXT,
      entered_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS production_shift_logs(
      id BIGSERIAL PRIMARY KEY,
      production_date DATE NOT NULL,
      shift TEXT NOT NULL,
      area TEXT NOT NULL,
      blooms_rolled INTEGER NOT NULL CHECK(blooms_rolled >= 0),
      operations_shift_incharge TEXT,
      remarks TEXT,
      entered_by TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS production_delays(
      id BIGSERIAL PRIMARY KEY,
      production_log_id BIGINT NOT NULL REFERENCES production_shift_logs(id) ON DELETE CASCADE,
      delay_section TEXT NOT NULL,
      delay_minutes INTEGER NOT NULL CHECK(delay_minutes >= 0),
      reason TEXT NOT NULL,
      job_action TEXT,
      entered_by TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS production_change_audit(
      id BIGSERIAL PRIMARY KEY,
      production_log_id BIGINT NOT NULL,
      old_data JSONB NOT NULL,
      new_data JSONB NOT NULL,
      change_reason TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      changed_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_prod_date_area ON production_shift_logs(production_date,area)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_shift_sessions(
      employee_number TEXT PRIMARY KEY,
      duty_date DATE NOT NULL,
      shift TEXT NOT NULL,
      checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      source TEXT NOT NULL DEFAULT 'explicit',
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employee_attendance(
      id BIGSERIAL PRIMARY KEY,
      employee_number TEXT NOT NULL,
      duty_date DATE NOT NULL,
      shift TEXT NOT NULL,
      check_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      entered_by TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'shift_checkin',
      UNIQUE(employee_number,duty_date,shift)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS section_event_log(
      id BIGSERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      event_text TEXT NOT NULL,
      employee_number TEXT NOT NULL,
      employee_name TEXT,
      section TEXT,
      area TEXT,
      responsibility TEXT,
      event_date DATE NOT NULL,
      event_shift TEXT,
      event_time TIME,
      entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      entered_by TEXT NOT NULL,
      timing_source TEXT NOT NULL DEFAULT 'entry_context',
      status TEXT NOT NULL DEFAULT 'recorded'
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_event_entries(
      employee_number TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      event_text TEXT NOT NULL,
      section TEXT,
      area TEXT,
      responsibility TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await pool.query(`ALTER TABLE section_event_log ADD COLUMN IF NOT EXISTS equipment_name TEXT`);
  await pool.query(`ALTER TABLE section_event_log ADD COLUMN IF NOT EXISTS source_media_ingestion_id BIGINT`);
  await pool.query(`ALTER TABLE production_shift_logs ADD COLUMN IF NOT EXISTS source_media_ingestion_id BIGINT`);
  await pool.query(`ALTER TABLE production_delays ADD COLUMN IF NOT EXISTS source_media_ingestion_id BIGINT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_section_event_date ON section_event_log(event_date,section,area,event_type)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_section_event_equipment ON section_event_log(equipment_name,event_date)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_ingestion(
      id BIGSERIAL PRIMARY KEY,
      employee_number TEXT NOT NULL,
      media_id TEXT NOT NULL,
      media_type TEXT NOT NULL,
      mime_type TEXT,
      filename TEXT,
      detected_language TEXT,
      extracted_text TEXT,
      extraction_json JSONB,
      status TEXT NOT NULL DEFAULT 'received',
      entered_by TEXT NOT NULL,
      entered_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_media_confirmations(
      employee_number TEXT PRIMARY KEY,
      media_ingestion_id BIGINT NOT NULL,
      proposed_json JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  // V5.4 audit-safe record control and batch ingestion metadata.
  await pool.query(`ALTER TABLE section_event_log ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE section_event_log ADD COLUMN IF NOT EXISTS deleted_by TEXT`);
  await pool.query(`ALTER TABLE section_event_log ADD COLUMN IF NOT EXISTS delete_reason TEXT`);
  await pool.query(`ALTER TABLE section_event_log ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE section_event_log ADD COLUMN IF NOT EXISTS edited_by TEXT`);
  await pool.query(`ALTER TABLE section_event_log ADD COLUMN IF NOT EXISTS original_event_text TEXT`);
  await pool.query(`ALTER TABLE section_event_log ADD COLUMN IF NOT EXISTS original_event_date DATE`);
  await pool.query(`ALTER TABLE production_shift_logs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE production_shift_logs ADD COLUMN IF NOT EXISTS deleted_by TEXT`);
  await pool.query(`ALTER TABLE production_delays ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE production_delays ADD COLUMN IF NOT EXISTS deleted_by TEXT`);
  await pool.query(`ALTER TABLE media_ingestion ADD COLUMN IF NOT EXISTS batch_code TEXT`);
  await pool.query(`ALTER TABLE media_ingestion ADD COLUMN IF NOT EXISTS record_count INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE media_ingestion ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE media_ingestion ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE media_ingestion ADD COLUMN IF NOT EXISTS rolled_back_by TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS technical_document_knowledge(
    id BIGSERIAL PRIMARY KEY, media_ingestion_id BIGINT NOT NULL, employee_number TEXT NOT NULL,
    document_class TEXT NOT NULL, title TEXT, equipment_name TEXT, identifiers JSONB,
    content_json JSONB NOT NULL, source_filename TEXT, entered_by TEXT NOT NULL, entered_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_technical_doc_equipment ON technical_document_knowledge(equipment_name,document_class)`);
  // V5.7 full-document knowledge index: page/section chunks remain linked to the source upload.
  await pool.query(`CREATE TABLE IF NOT EXISTS technical_document_chunks(
    id BIGSERIAL PRIMARY KEY, media_ingestion_id BIGINT NOT NULL, knowledge_id BIGINT,
    employee_number TEXT NOT NULL, document_class TEXT NOT NULL, title TEXT,
    equipment_name TEXT, identifiers JSONB, page_start INTEGER, page_end INTEGER,
    section_heading TEXT, content_text TEXT NOT NULL, source_filename TEXT,
    entered_by TEXT NOT NULL, entered_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_technical_chunks_media ON technical_document_chunks(media_ingestion_id,page_start)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_technical_chunks_equipment ON technical_document_chunks(equipment_name,document_class)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_technical_chunks_text ON technical_document_chunks USING GIN (to_tsvector('english',coalesce(section_heading,'')||' '||coalesce(content_text,'')))`);
  // V6.0 resilient universal-ingestion checkpoints. A page/frame/sheet failure must not kill the batch.
  await pool.query(`CREATE TABLE IF NOT EXISTS ingestion_checkpoints(
    id BIGSERIAL PRIMARY KEY, media_ingestion_id BIGINT NOT NULL, unit_type TEXT NOT NULL,
    unit_start INTEGER NOT NULL, unit_end INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(media_ingestion_id,unit_type,unit_start,unit_end))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ingestion_checkpoint_media ON ingestion_checkpoints(media_ingestion_id,status)`);


  await pool.query(`CREATE TABLE IF NOT EXISTS record_change_audit(
    id BIGSERIAL PRIMARY KEY, record_table TEXT NOT NULL, record_id BIGINT NOT NULL,
    action TEXT NOT NULL, before_json JSONB, after_json JSONB, employee_number TEXT,
    changed_by TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT now(), reason TEXT
  )`);
  // V7.1 durable file intake + background jobs. These survive Render restarts.
  await pool.query(`CREATE TABLE IF NOT EXISTS file_upload_sources(
    id BIGSERIAL PRIMARY KEY, employee_number TEXT NOT NULL, whatsapp_number TEXT NOT NULL,
    media_id TEXT NOT NULL, filename TEXT, mime_type TEXT, source_kind TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ,
    UNIQUE(employee_number,media_id)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_file_source_latest ON file_upload_sources(employee_number,source_kind,received_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS background_jobs(
    id BIGSERIAL PRIMARY KEY, job_code TEXT UNIQUE, employee_number TEXT NOT NULL,
    whatsapp_number TEXT NOT NULL, job_type TEXT NOT NULL, media_id TEXT NOT NULL,
    source_filename TEXT, source_mime_type TEXT, status TEXT NOT NULL DEFAULT 'queued',
    progress_current INTEGER NOT NULL DEFAULT 0, progress_total INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, result_meta JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bg_jobs_status ON background_jobs(status,created_at)`);
  // V7.4 Universal Search: per-user context, ambiguity choices and safe learned aliases.
  await pool.query(`CREATE TABLE IF NOT EXISTS search_context(
    employee_number TEXT PRIMARY KEY, department_code TEXT NOT NULL DEFAULT '35',
    area TEXT, equipment_name TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`ALTER TABLE search_context ADD COLUMN IF NOT EXISTS module TEXT`);
  await pool.query(`ALTER TABLE search_context ADD COLUMN IF NOT EXISTS date_from DATE`);
  await pool.query(`ALTER TABLE search_context ADD COLUMN IF NOT EXISTS date_to DATE`);
  await pool.query(`ALTER TABLE search_context ADD COLUMN IF NOT EXISTS page_offset INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE search_context ADD COLUMN IF NOT EXISTS last_query TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS search_aliases(
    id BIGSERIAL PRIMARY KEY, department_code TEXT NOT NULL DEFAULT '35', alias_text TEXT NOT NULL,
    canonical_text TEXT NOT NULL, equipment_name TEXT, confidence NUMERIC NOT NULL DEFAULT 0.90,
    confirmed BOOLEAN NOT NULL DEFAULT FALSE, usage_count INTEGER NOT NULL DEFAULT 0,
    learned_from TEXT, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ, UNIQUE(department_code,alias_text,canonical_text))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS pending_search_choices(
    employee_number TEXT PRIMARY KEY, original_query TEXT NOT NULL, choices JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_search_alias ON search_aliases(department_code,LOWER(alias_text))`);
  // V7.5 source-backed LMMM master/search layer. Data stays separate from live event capture.
  await pool.query(`CREATE TABLE IF NOT EXISTS lmmm_master_records(
    uid TEXT PRIMARY KEY, record_type TEXT NOT NULL, equipment TEXT, area TEXT, event_date TEXT,
    record_text TEXT NOT NULL, source_name TEXT, source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lmmm_master_type_equipment ON lmmm_master_records(record_type,LOWER(equipment))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lmmm_master_fts ON lmmm_master_records USING GIN(to_tsvector('simple',record_text))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lmmm_knowledge_records(
    uid TEXT PRIMARY KEY, source_name TEXT NOT NULL, source_row TEXT, entity_types TEXT[] DEFAULT '{}',
    raw_text TEXT NOT NULL, normalized_text TEXT NOT NULL, identifiers TEXT[] DEFAULT '{}',
    verification_status TEXT NOT NULL, source_payload JSONB NOT NULL DEFAULT '{}'::jsonb)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lmmm_knowledge_fts ON lmmm_knowledge_records USING GIN(to_tsvector('simple',normalized_text))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lmmm_master_sync_meta(sync_key TEXT PRIMARY KEY, record_count INTEGER, synced_at TIMESTAMPTZ DEFAULT now())`);
  await syncBundledLmmmKnowledge();
  await pool.query(`DELETE FROM file_upload_sources WHERE expires_at IS NOT NULL AND expires_at < now()`);
  // A deploy/restart can interrupt an in-process worker. Requeue stale running jobs.
  await pool.query(`UPDATE background_jobs SET status='queued', started_at=NULL,
    last_error=CASE WHEN last_error IS NULL OR last_error='' THEN 'Recovered after service restart' ELSE last_error END
    WHERE status='running'`);
  console.log('[DATABASE] V4.4 hierarchy + authority foundation ready');
  console.log('[ADMIN] configured:', SUPER_ADMIN_NUMBERS.size);
}

async function sendText(to, body) {
  const r = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body }
      })
    }
  );

  const d = await r.json();
  if (!r.ok) {
    console.error('[WHATSAPP SEND ERROR]', r.status, d);
    throw new Error('send failed');
  }

  console.log('[WHATSAPP] Sent OK', to);
  return d;
}

// V7.7.4 WhatsApp-safe search rendering: long result text and interactive controls are sent separately.
// Interactive body text is limited to 1024 chars by WhatsApp, while normal text can safely carry larger result blocks.
async function sendLongText(to, body, maxLen=3500){
  const text=String(body||'').trim();
  if(!text)return;
  let rest=text;
  while(rest.length>maxLen){
    let cut=rest.lastIndexOf('\n\n',maxLen);
    if(cut<Math.floor(maxLen*0.55))cut=rest.lastIndexOf('\n',maxLen);
    if(cut<Math.floor(maxLen*0.55))cut=rest.lastIndexOf(' ',maxLen);
    if(cut<1)cut=maxLen;
    await sendText(to,rest.slice(0,cut).trim());
    rest=rest.slice(cut).trim();
  }
  if(rest)await sendText(to,rest);
}
async function sendSearchTextAndButtons(to,text,buttons){
  await sendLongText(to,text);
  if(buttons?.length){
    try{ await sendButtons(to,'Search options',buttons); }
    catch(e){
      // Never turn a successful database search into a false “No matching record” just because UI controls failed.
      console.error('[SEARCH OPTIONS SEND]',e);
      await sendText(to,'Options: '+buttons.map(b=>b.title).join(' | ')).catch(()=>{});
    }
  }
}

async function uploadWhatsAppMedia(buf,mime,filename){
  const fd=new FormData();
  fd.append('messaging_product','whatsapp'); fd.append('type',mime||'application/octet-stream');
  fd.append('file',new Blob([buf],{type:mime||'application/octet-stream'}),filename||'file');
  const r=await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/media`,{method:'POST',headers:{Authorization:`Bearer ${ACCESS_TOKEN}`},body:fd});
  const d=await r.json(); if(!r.ok||!d.id)throw new Error(`WhatsApp media upload failed ${r.status}: ${JSON.stringify(d)}`); return d.id;
}
async function sendDocumentBuffer(to,buf,filename,caption='',mime='application/pdf'){
  const id=await uploadWhatsAppMedia(buf,mime,filename);
  const r=await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,{method:'POST',headers:{Authorization:`Bearer ${ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to,type:'document',document:{id,filename,caption:String(caption||'').slice(0,1024)}})});
  const d=await r.json(); if(!r.ok)throw new Error(`WhatsApp document send failed ${r.status}: ${JSON.stringify(d)}`); return d;
}
async function tiffToPdfBuffer(buf,onProgress=null){
  // Native TIFF conversion is optional. Never let a missing native module stop the WhatsApp bot.
  let sharp, PDFDocument;
  try {
    ({ default: sharp } = await import('sharp'));
  } catch (e) {
    const err = new Error('TIFF converter is temporarily unavailable on this server (optional image engine not installed). The maintenance bot remains online.');
    err.code = 'TIFF_CONVERTER_UNAVAILABLE';
    throw err;
  }
  try {
    ({ PDFDocument } = await import('pdf-lib'));
  } catch (e) {
    const err = new Error('TIFF converter is temporarily unavailable on this server (PDF engine not installed). The maintenance bot remains online.');
    err.code = 'TIFF_CONVERTER_UNAVAILABLE';
    throw err;
  }
  // Large engineering TIFFs can exceed Sharp's default aggregate pixel limit. We never decode
  // all frames into one raster: metadata first, then exactly one frame at a time, resized before PNG encoding.
  const sharpOpts={pages:-1,limitInputPixels:false,sequentialRead:true,failOn:'none'};
  const meta=await sharp(buf,sharpOpts).metadata();
  const pages=Math.max(1,Number(meta.pages)||1);
  if(pages>1000) throw new Error(`TIFF has ${pages} frames; safety limit is 1000.`);
  const pdf=await PDFDocument.create();
  if(onProgress) await onProgress(0,pages);
  for(let i=0;i<pages;i++){
    const probe=sharp(buf,{page:i,pages:1,limitInputPixels:false,sequentialRead:true,failOn:'none'}).rotate();
    const m=await probe.metadata();
    const w0=Math.max(1,Number(m.width)||1),h0=Math.max(1,Number(m.height)||1);
    const maxSide=1400, resizeScale=Math.min(1,maxSide/Math.max(w0,h0));
    const outW=Math.max(1,Math.round(w0*resizeScale)),outH=Math.max(1,Math.round(h0*resizeScale));
    const jpg=await probe.resize({width:outW,height:outH,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:68,mozjpeg:true}).toBuffer();
    const emb=await pdf.embedJpg(jpg);
    const pdfScale=Math.min(1,1440/Math.max(outW,outH));
    const page=pdf.addPage([outW*pdfScale,outH*pdfScale]);
    page.drawImage(emb,{x:0,y:0,width:outW*pdfScale,height:outH*pdfScale});
    if(onProgress) await onProgress(i+1,pages);
    // Yield between frames so WhatsApp text/database requests stay responsive.
    await new Promise(resolve=>setImmediate(resolve));
  }
  return {buffer:Buffer.from(await pdf.save()),pages};
}

let backgroundWorkerBusy=false;
function jobCode(id){ return `JOB-${String(id).padStart(6,'0')}`; }
async function rememberDurableSource(u,from,mediaId,name,mime,kind){
  if(!pool)return;
  await pool.query(`INSERT INTO file_upload_sources(employee_number,whatsapp_number,media_id,filename,mime_type,source_kind,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,now()+interval '6 days') ON CONFLICT(employee_number,media_id)
    DO UPDATE SET filename=EXCLUDED.filename,mime_type=EXCLUDED.mime_type,source_kind=EXCLUDED.source_kind,received_at=now(),expires_at=EXCLUDED.expires_at`,
    [u.employee_number,from,String(mediaId),name||null,mime||null,kind]);
}
async function enqueueConversionJob(u,from,mediaId,name,mime,kind){
  const type=kind==='tiff'?'tiff_to_pdf':'access_to_excel';
  // Prevent accidental duplicate taps from creating duplicate conversions.
  const ex=await pool.query(`SELECT * FROM background_jobs WHERE employee_number=$1 AND media_id=$2 AND job_type=$3 AND status IN ('queued','running') ORDER BY id DESC LIMIT 1`,[u.employee_number,String(mediaId),type]);
  if(ex.rows[0]) return ex.rows[0];
  const q=await pool.query(`INSERT INTO background_jobs(employee_number,whatsapp_number,job_type,media_id,source_filename,source_mime_type)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[u.employee_number,from,type,String(mediaId),name||null,mime||null]);
  const row=q.rows[0], code=jobCode(row.id);
  await pool.query(`UPDATE background_jobs SET job_code=$2 WHERE id=$1`,[row.id,code]); row.job_code=code;
  setImmediate(()=>kickBackgroundWorker().catch(e=>console.error('[BG WORKER KICK]',e)));
  return row;
}
async function cleanupCompletedSource(j){
  // Delete only temporary source metadata/pointers. Structured maintenance data/audit remain permanent.
  await pool.query(`DELETE FROM file_upload_sources WHERE employee_number=$1 AND media_id=$2`,[j.employee_number,String(j.media_id)]).catch(()=>{});
  recentSourceCache.delete(String(j.media_id));
  const latest=latestConvertibleSource.get(String(j.employee_number));
  if(latest && String(latest.mediaId)===String(j.media_id)) latestConvertibleSource.delete(String(j.employee_number));
}

async function runBackgroundJob(j){
  try{
    await pool.query(`UPDATE background_jobs SET status='running',attempts=attempts+1,started_at=coalesce(started_at,now()),heartbeat_at=now(),last_error=NULL WHERE id=$1`,[j.id]);
    const meta=await mediaMeta(j.media_id); const buf=await mediaBytes(meta.url);
    if(j.job_type==='tiff_to_pdf'){
      let lastWrite=0;
      const out=await tiffToPdfBuffer(buf,async(cur,total)=>{ const now=Date.now(); if(cur===0||cur===total||now-lastWrite>4000){lastWrite=now;await pool.query(`UPDATE background_jobs SET progress_current=$2,progress_total=$3,heartbeat_at=now() WHERE id=$1`,[j.id,cur,total]);}});
      const base=String(j.source_filename||'LMMM_TIFF').replace(/\.tiff?$/i,'');
      await sendDocumentBuffer(j.whatsapp_number,out.buffer,`${base}.pdf`,`✅ TIFF → PDF complete • ${out.pages}/${out.pages} pages • ${j.job_code}`);
      await pool.query(`UPDATE background_jobs SET status='completed',progress_current=$2,progress_total=$2,result_meta=$3,completed_at=now(),heartbeat_at=now() WHERE id=$1`,[j.id,out.pages,JSON.stringify({pages:out.pages,filename:`${base}.pdf`})]);
      await cleanupCompletedSource(j);
    }else if(j.job_type==='access_to_excel'){
      const out=await accessToExcelBuffer(buf); const base=String(j.source_filename||'LMMM_Access').replace(/\.(mdb|accdb)$/i,'');
      await sendDocumentBuffer(j.whatsapp_number,out.buffer,`${base}.xlsx`,`${out.errors?.length?'⚠️ Access → Excel partial':'✅ Access → Excel complete'} • ${out.sheets}/${out.tables} tables • ${out.totalRows} rows • ${j.job_code}${out.errors?.length?' • Failed: '+out.errors.slice(0,3).join(' | '):''}`,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      await pool.query(`UPDATE background_jobs SET status='completed',progress_current=$2,progress_total=$2,result_meta=$3,completed_at=now(),heartbeat_at=now() WHERE id=$1`,[j.id,out.tables,JSON.stringify({tables:out.tables,sheets:out.sheets,rows:out.totalRows,filename:`${base}.xlsx`})]);
      await cleanupCompletedSource(j);
    }
  }catch(e){
    const msg=String(e?.message||e).slice(0,500); console.error('[BACKGROUND JOB]',j.job_code,e);
    const rr=await pool.query(`UPDATE background_jobs SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,last_error=$2,heartbeat_at=now() WHERE id=$1 RETURNING status,attempts`,[j.id,msg]);
    if(rr.rows[0]?.status==='failed') await sendText(j.whatsapp_number,`⚠️ ${j.job_code} failed after ${rr.rows[0].attempts} attempts: ${msg.slice(0,180)}\nYou can continue using the bot; send RETRY ${j.job_code} to try again.`);
  }
}
async function kickBackgroundWorker(){
  if(backgroundWorkerBusy||!pool)return; backgroundWorkerBusy=true;
  try{
    while(true){
      const c=await pool.connect(); let j=null;
      try{await c.query('BEGIN'); const q=await c.query(`SELECT * FROM background_jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`); j=q.rows[0]; if(j)await c.query(`UPDATE background_jobs SET status='running',heartbeat_at=now() WHERE id=$1`,[j.id]); await c.query('COMMIT');}
      catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
      if(!j)break; await runBackgroundJob(j);
    }
  }finally{backgroundWorkerBusy=false;}
}
async function latestDurableSource(employeeNumber,kind){
  const q=await pool.query(`SELECT * FROM file_upload_sources WHERE employee_number=$1 AND source_kind=$2 AND (expires_at IS NULL OR expires_at>now()) ORDER BY received_at DESC,id DESC LIMIT 1`,[employeeNumber,kind]);
  return q.rows[0]||null;
}

async function accessToExcelBuffer(buf){
  let MDBReader, XLSX;
  try{const mod=await import('mdb-reader'); MDBReader=mod.default||mod.MDBReader||mod;}catch(e){throw new Error('Access reader is unavailable on this server.');}
  try{XLSX=await import('xlsx');}catch(e){throw new Error('Excel writer is unavailable on this server.');}
  const db=new MDBReader(buf), wb=XLSX.utils.book_new();

  // ACCDB/MDB may contain normal + linked user tables.  Never stop at the
  // first table and never report COMPLETE until every discovered user table
  // has either become a worksheet or is reported as failed.
  const discovered=[];
  const addNames=(v)=>{for(const n of (Array.isArray(v)?v:[])){const x=String(n||'').trim();if(x&&!discovered.includes(x))discovered.push(x);}};
  try{addNames(db.getTableNames());}catch{}
  try{addNames(db.getTableNames({normalTables:true,systemTables:false,linkedTables:true}));}catch{}
  if(!discovered.length) throw new Error('No Access user tables were discovered.');

  let totalRows=0, sheets=0; const errors=[], tableStats=[];
  const used=new Set();
  const safeSheet=(raw)=>{
    let base=String(raw||`Table${sheets+1}`).replace(/[\\/?*\[\]:]/g,'_').trim().slice(0,31)||`Table${sheets+1}`;
    let name=base,n=2; while(used.has(name.toLowerCase())) name=(base.slice(0,27)+'_'+n++).slice(0,31);
    used.add(name.toLowerCase()); return name;
  };
  for(const tableName of discovered){
    try{
      const table=db.getTable(tableName);
      const rows=table.getData()||[];
      let headers=[];
      try{ if(typeof table.getColumnNames==='function') headers=table.getColumnNames()||[]; }catch{}
      if(!headers.length&&rows.length) headers=Object.keys(rows[0]);
      const ws=rows.length?XLSX.utils.json_to_sheet(rows,{header:headers.length?headers:undefined}):XLSX.utils.aoa_to_sheet(headers.length?[headers]:[]);
      ws['!cols']=headers.map(k=>({wch:Math.min(45,Math.max(12,String(k).length+2,...rows.slice(0,200).map(r=>String(r?.[k]??'').length+2)))}));
      const sheetName=safeSheet(tableName); XLSX.utils.book_append_sheet(wb,ws,sheetName);
      totalRows+=rows.length; sheets++; tableStats.push({table:tableName,sheet:sheetName,rows:rows.length,status:'converted'});
    }catch(e){errors.push(`${tableName}: ${String(e?.message||e).slice(0,180)}`);tableStats.push({table:tableName,rows:0,status:'failed'});}
  }
  if(!sheets) throw new Error(`No readable Access tables. ${errors.slice(0,3).join('; ')}`);
  const status=errors.length?'partial':'complete';
  return {buffer:Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx'})),tables:discovered.length,sheets,totalRows,errors,tableStats,status};
}

async function spreadsheetConvertBuffer(buf, sourceName, target){
  let XLSX; try{XLSX=await import('xlsx');}catch(e){throw new Error('Spreadsheet converter is unavailable on this server.');}
  const wb=XLSX.read(buf,{type:'buffer',cellDates:true});
  if(target==='xlsx') return {buffer:Buffer.from(XLSX.write(wb,{type:'buffer',bookType:'xlsx'})),sheets:wb.SheetNames.length,filename:String(sourceName||'data').replace(/\.(csv|xls|xlsx)$/i,'')+'.xlsx'};
  if(target==='csv'){
    if(!wb.SheetNames.length) throw new Error('No readable spreadsheet sheets found.');
    if(wb.SheetNames.length===1){const csv=XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);return {buffer:Buffer.from('\ufeff'+csv),sheets:1,filename:String(sourceName||'data').replace(/\.(xls|xlsx|csv)$/i,'')+'.csv',mime:'text/csv'};}
    let JSZip; try{const m=await import('jszip');JSZip=m.default||m;}catch(e){throw new Error('CSV ZIP writer is unavailable on this server.');}
    const zip=new JSZip(); const used=new Set();
    for(const sh of wb.SheetNames){let base=String(sh||'Sheet').replace(/[\\/:*?\"<>|]/g,'_').slice(0,80)||'Sheet',name=base,n=2;while(used.has(name.toLowerCase()))name=`${base}_${n++}`;used.add(name.toLowerCase());zip.file(name+'.csv','\ufeff'+XLSX.utils.sheet_to_csv(wb.Sheets[sh]));}
    return {buffer:await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),sheets:wb.SheetNames.length,filename:String(sourceName||'data').replace(/\.(xls|xlsx|csv)$/i,'')+'_CSV.zip',mime:'application/zip'};
  }
  throw new Error('Unsupported spreadsheet conversion target.');
}

async function sendButtons(to, body, buttons) {
  const safeButtons = (buttons || []).slice(0, 3).map(b => ({
    type: 'reply',
    reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) }
  }));

  const r = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body },
          action: { buttons: safeButtons }
        }
      })
    }
  );

  const d = await r.json();
  if (!r.ok) {
    console.error('[WHATSAPP BUTTON ERROR]', r.status, d);
    throw new Error('interactive send failed');
  }
  console.log('[WHATSAPP] Buttons sent OK', to);
  return d;
}


async function sendList(to, body, buttonText, rows, sectionTitle='Select') {
  const r = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      method:'POST',
      headers:{ Authorization:`Bearer ${ACCESS_TOKEN}`, 'Content-Type':'application/json' },
      body:JSON.stringify({
        messaging_product:'whatsapp',
        to,
        type:'interactive',
        interactive:{
          type:'list',
          body:{text:body},
          action:{
            button:buttonText,
            sections:[{
              title:sectionTitle,
              rows:(rows||[]).slice(0,10).map(x=>({
                id:String(x.id).slice(0,200),
                title:String(x.title).slice(0,24),
                ...(x.description?{description:String(x.description).slice(0,72)}:{})
              }))
            }]
          }
        }
      })
    }
  );
  const d=await r.json();
  if(!r.ok){ console.error('[WHATSAPP LIST ERROR]',r.status,d); throw new Error('interactive list send failed'); }
  return d;
}

function parseReg(text) {
  const raw = String(text || '').trim();
  const p = (raw.includes('/') ? raw.split('/') : raw.split(/\r?\n/))
    .map(x => x.trim())
    .filter(Boolean);

  if (p.length < 5) return null;

  const [name, employee_number, designation, section, area] = p;

  if (!name || !/^\d+$/.test(employee_number || '') || !designation || !section || !area) {
    return null;
  }

  return {
    name,
    employee_number,
    designation,
    section,
    area,
    responsibility: NA
  };
}

async function byWA(wa) {
  const r = await pool.query(
    'SELECT * FROM users WHERE whatsapp_number=$1 LIMIT 1',
    [wa]
  );
  return r.rows[0] || null;
}

async function byEmp(emp) {
  const r = await pool.query(
    'SELECT * FROM users WHERE employee_number=$1 LIMIT 1',
    [emp]
  );
  return r.rows[0] || null;
}

async function deleteRegistrationByEmployee(employeeNumber) {
  await pool.query('BEGIN');
  try {
    await pool.query(
      'DELETE FROM user_special_permissions WHERE employee_number=$1',
      [employeeNumber]
    );
    await pool.query(
      'DELETE FROM user_responsibilities WHERE employee_number=$1',
      [employeeNumber]
    );
    await pool.query(
      'DELETE FROM user_assignments WHERE employee_number=$1',
      [employeeNumber]
    );
    const r = await pool.query(
      'DELETE FROM users WHERE employee_number=$1 RETURNING whatsapp_number,name,employee_number',
      [employeeNumber]
    );
    await pool.query('COMMIT');
    return r.rows[0] || null;
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  }
}

async function deleteRegistrationByWA(wa) {
  const u = await byWA(wa);
  if (!u) return null;
  return deleteRegistrationByEmployee(u.employee_number);
}

async function notifyAdmins(d) {
  if (!SUPER_ADMIN_NUMBERS.size) {
    console.error('[APPROVAL] SUPER_ADMIN_NUMBERS is empty');
    return false;
  }

  const body =
    `Registration Approval\n\n` +
    `Name: ${d.name}\n` +
    `Emp No: ${d.employee_number}\n` +
    `Designation: ${d.designation}\n` +
    `Section: ${d.section}\n` +
    `Area: ${d.area}`;

  let sent = 0;
  for (const admin of SUPER_ADMIN_NUMBERS) {
    try {
      await sendButtons(admin, body, [
        { id: `APPROVE:${d.employee_number}`, title: 'Approve' },
        { id: `REJECT:${d.employee_number}`, title: 'Reject' }
      ]);
      sent++;
      console.log('[APPROVAL] Buttons sent to', admin);
    } catch (e) {
      console.error('[APPROVAL SEND ERROR]', admin, e);
    }
  }
  return sent > 0;
}


function normalizedDesignation(v='') {
  return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}

function employeeCategory(designation='') {
  const d = normalizedDesignation(designation);
  if (['kalasi','technician','chargeman','foreman','acting foreman','general foreman'].includes(d)) {
    return 'NON_EXECUTIVE';
  }
  if (
    d.includes('unskilled') || d.includes('helper') ||
    d.includes('semi skilled') || d.includes('semi-skilled') ||
    d.includes('welder') || d.includes('fitter') || d.includes('rigger') ||
    d === 'supervisor' || d.includes('skilled')
  ) return 'CONTRACT';
  return 'EXECUTIVE';
}

function designationBand(designation='') {
  const d = normalizedDesignation(designation);
  if (['deputy general manager','dgm'].includes(d)) return 'DGM';
  if ([
    'management trainee','junior manager','asst manager','assistant manager',
    'deputy manager','manager','sr manager','senior manager',
    'asst general manager','assistant general manager','agm'
  ].includes(d)) return 'EXECUTIVE_UPTO_AGM';
  return employeeCategory(designation);
}

function accessLabel(code=''){
  const m={FULL_ACCESS:'Full Access',ENTRY:'Entry',VIEW:'View',EDIT:'View + Edit / Entry',DELETE_UNDO:'Delete / Undo',APPROVAL:'Approval',PRINT_EXPORT:'PDF / Print',ANALYSIS:'Analysis',REPORTS:'Reports',ADVANCED_REPORTS:'Advanced Reports',RCM:'RCM Analysis',MASTER_EDIT:'Master Edit',ACCESS_ADMIN:'Access Admin'};
  return m[String(code).toUpperCase()]||String(code).replaceAll('_',' ');
}
function inheritedPermissionCodes({designation='',operationalRole='NORMAL_USER',responsibilities=[]}={}){
  const category=employeeCategory(designation), band=designationBand(designation);
  const roles=new Set((responsibilities||[]).map(x=>String(x.responsibility_role||x||'').trim().toUpperCase().replace(/[ -]+/g,'_')));
  const op=String(operationalRole||'NORMAL_USER').toUpperCase();
  const out=new Set();
  // Registration/hierarchy is the INITIAL baseline only. Super Admin manual Access selection replaces this baseline.
  // Non-executive: relevant-scope data entry + view. Executive through AGM: entry/view + analysis + on-screen reports, but no print/export by default.
  if(category==='NON_EXECUTIVE' || category==='CONTRACT'){ ['ENTRY','VIEW','EDIT'].forEach(x=>out.add(x)); }
  else { ['ENTRY','VIEW','EDIT','ANALYSIS','REPORTS'].forEach(x=>out.add(x)); }
  // Approved hierarchy elevates authority. Area/shift/general-shift roles change scope, not hidden report/print rights.
  const sectionFull = band==='DGM' || ['HOD','SECTION_INCHARGE'].includes(op) || roles.has('HOD') || roles.has('SECTION_IN_CHARGE') || roles.has('SECTION_INCHARGE');
  if(sectionFull){ ['FULL_ACCESS','ENTRY','VIEW','EDIT','DELETE_UNDO','APPROVAL','PRINT_EXPORT','ANALYSIS','REPORTS','ADVANCED_REPORTS','RCM'].forEach(x=>out.add(x)); }
  if(op==='SUPER_ADMIN'||roles.has('SUPER_ADMIN')||roles.has('OWNER')){ ['FULL_ACCESS','ENTRY','VIEW','EDIT','DELETE_UNDO','APPROVAL','PRINT_EXPORT','ANALYSIS','REPORTS','ADVANCED_REPORTS','RCM','MASTER_EDIT','ACCESS_ADMIN'].forEach(x=>out.add(x)); }
  return [...out];
}
async function syncDefaultAccess(employeeNumber,performedBy='SYSTEM',reason='Registration / hierarchy baseline'){
  const u=await byEmp(employeeNumber); if(!u)return [];
  const rr=await pool.query(`SELECT responsibility_role FROM user_responsibilities WHERE employee_number=$1 AND active=true AND (valid_from IS NULL OR valid_from<=now()) AND (valid_to IS NULL OR valid_to>=now())`,[employeeNumber]);
  const perms=inheritedPermissionCodes({designation:u.designation,operationalRole:u.operational_role,responsibilities:rr.rows});
  const section=u.section_department||NA, area=u.area_of_working||NA;
  // Do not use pool-level BEGIN/COMMIT here: pg.Pool may route statements to
  // different connections. Each statement is idempotent, so safe upserts are more robust.
  await pool.query(`UPDATE user_default_permissions SET active=false,calculated_at=now() WHERE employee_number=$1`,[employeeNumber]);
  for(const permission of perms){
    await pool.query(`INSERT INTO user_default_permissions(employee_number,permission,source_type,source_detail,scope_section,scope_area,active,calculated_at)
      VALUES($1,$2,'REGISTRATION_HIERARCHY',$3,$4,$5,true,now())
      ON CONFLICT(employee_number,permission) DO UPDATE SET source_type=EXCLUDED.source_type,source_detail=EXCLUDED.source_detail,scope_section=EXCLUDED.scope_section,scope_area=EXCLUDED.scope_area,active=true,calculated_at=now()`,
      [employeeNumber,permission,reason,section,area]);
  }
  try{
    await pool.query(`INSERT INTO authority_audit(employee_number,action,scope_section,scope_area,performed_by,details) VALUES($1,'SYNC_DEFAULT_ACCESS',$2,$3,$4,$5::jsonb)`,[employeeNumber,section,area,performedBy,JSON.stringify({permissions:perms,reason})]);
  }catch(e){ console.error('[ACCESS AUDIT NONFATAL]',e.message); }
  return perms;
}
async function defaultPermissionRows(employeeNumber){
  return (await pool.query(`SELECT permission,source_type,source_detail,scope_section,scope_area FROM user_default_permissions WHERE employee_number=$1 AND active=true ORDER BY permission`,[employeeNumber])).rows;
}

async function effectiveAuthority(employeeNumber) {
  const ur = await pool.query(
    `SELECT employee_number,designation,section_department,area_of_working,approval_status,is_active,operational_role
     FROM users WHERE employee_number=$1 LIMIT 1`,
    [employeeNumber]
  );
  const u = ur.rows[0];
  if (!u || u.approval_status !== 'approved' || !u.is_active) return null;

  const rr = await pool.query(
    `SELECT * FROM user_responsibilities
     WHERE employee_number=$1 AND active=true
       AND (valid_from IS NULL OR valid_from<=now())
       AND (valid_to IS NULL OR valid_to>=now())
     ORDER BY created_at DESC`,
    [employeeNumber]
  );

  const prAll = await pool.query(
    `SELECT permission,active FROM user_special_permissions
     WHERE employee_number=$1
       AND (valid_from IS NULL OR valid_from<=now())
       AND (valid_to IS NULL OR valid_to>=now())`,
    [employeeNumber]
  );
  const pr = { rows: prAll.rows.filter(x=>x.active===true) };
  // Manual override is explicit state, not inferred from legacy permission rows.
  // This prevents registration/hierarchy FULL access from leaking back after a Super Admin downgrade.
  const ovRow=(await pool.query(`SELECT enabled,permissions,updated_by,updated_at FROM user_access_override WHERE employee_number=$1 LIMIT 1`,[employeeNumber])).rows[0]||null;
  const hasAccessOverride = ovRow?.enabled===true;
  const overridePermissions = hasAccessOverride && Array.isArray(ovRow.permissions) ? ovRow.permissions.map(x=>String(x).toUpperCase()) : [];
  const agr = await pool.query(
    `SELECT authority_code FROM user_authority_grants
     WHERE employee_number=$1 AND active=true
       AND (valid_from IS NULL OR valid_from<=now())
       AND (valid_to IS NULL OR valid_to>=now())`,
    [employeeNumber]
  );
  const ar = await pool.query(
    `SELECT * FROM user_assignments
     WHERE employee_number=$1 AND active=true
       AND (valid_from IS NULL OR valid_from<=now())
       AND (valid_to IS NULL OR valid_to>=now())
     ORDER BY id DESC`,
    [employeeNumber]
  );

  const roles = rr.rows.map(x => String(x.responsibility_role || '').trim().toLowerCase());
  const superAdminRole = roles.includes('super admin') || roles.includes('superadmin') || roles.includes('owner');
  const hod = roles.includes('hod');
  const sectionIncharge = roles.includes('section in-charge') || roles.includes('section incharge');
  const areaIncharge = roles.includes('area in-charge') || roles.includes('area incharge');
  const band = designationBand(u.designation);
  const category = employeeCategory(u.designation);
  const specialSet = new Set(pr.rows.map(x => String(x.permission||'').toUpperCase()));

  let effectiveAccess = category === 'EXECUTIVE' ? 'ENTRY_VIEW' : 'ENTRY';
  let scope = 'REGISTERED_SCOPE';

  // Explicit Super Admin/Owner responsibility or permission is plant-wide full access.
  if (superAdminRole || specialSet.has('SUPER_ADMIN') || specialSet.has('OWNER')) {
    effectiveAccess = 'FULL';
    scope = 'PLANT_WIDE';
  }
  // DGM gets full access only to the assigned/registered section.
  if (band === 'DGM' && scope !== 'PLANT_WIDE') {
    effectiveAccess = 'FULL';
    scope = 'ASSIGNED_SECTION';
  }
  // Responsibility overrides designation assumptions.
  if (areaIncharge && scope !== 'PLANT_WIDE') scope = 'ASSIGNED_AREA';
  if (sectionIncharge && scope !== 'PLANT_WIDE') {
    effectiveAccess = 'FULL';
    scope = 'ASSIGNED_SECTION';
  }
  // HOD can be DGM, GM, or another authorized designation: HOD responsibility controls scope.
  if (hod && scope !== 'PLANT_WIDE') {
    effectiveAccess = 'FULL';
    scope = 'ALL_SECTIONS';
  }

  const defaultRows = await defaultPermissionRows(employeeNumber);
  // Backfill old approved users on first access without changing explicit grants.
  if (!defaultRows.length) {
    await syncDefaultAccess(employeeNumber,'SYSTEM','Backfilled from approved registration + current hierarchy');
    defaultRows.splice(0,0,...(await defaultPermissionRows(employeeNumber)));
  }

  return {
    employee_number: u.employee_number,
    designation: u.designation,
    employee_category: category,
    designation_band: band,
    registered_section: u.section_department,
    registered_area: u.area_of_working,
    responsibilities: rr.rows,
    assignments: ar.rows,
    effective_access: effectiveAccess,
    scope,
    default_permissions: defaultRows,
    special_permissions: pr.rows.map(x => x.permission),
    override_permissions: overridePermissions,
    has_access_override: hasAccessOverride,
    authority_grants: agr.rows.map(x => String(x.authority_code||'').toUpperCase()),
    operational_role: u.operational_role || 'NORMAL_USER'
  };
}


const RESPONSIBILITY_OPTIONS = [
  ['HOD','HOD'],
  ['SECTION_INCHARGE','Section In-charge'],
  ['AREA_INCHARGE','Area In-charge'],
  ['SHIFT_INCHARGE','Shift In-charge'],
  ['GENERAL_SHIFT','General Shift'],
  ['NORMAL_EMPLOYEE','Normal Employee']
];

async function sendResponsibilityPicker(to, employeeNumber) {
  await sendList(
    to,
    `Set responsibility\nEmployee No: ${employeeNumber}`,
    'Select',
    RESPONSIBILITY_OPTIONS.map(([code,title])=>({
      id:`RESP:${code}:${employeeNumber}`, title
    })),
    'Responsibility'
  );
}

async function setResponsibility(from, employeeNumber, code) {
  const u=await byEmp(employeeNumber);
  if(!u || u.approval_status!=='approved' || !u.is_active){
    await sendText(from,'Not found.');
    return;
  }
  const labels={
    HOD:'HOD',
    SECTION_INCHARGE:'Section In-charge',
    AREA_INCHARGE:'Area In-charge',
    SHIFT_INCHARGE:'Shift In-charge',
    GENERAL_SHIFT:'General Shift',
    NORMAL_EMPLOYEE:'Normal Employee'
  };
  const role=labels[code];
  if(!role){ await sendText(from,'Not found.'); return; }

  // Never infer responsibility from designation.
  // Until exact Section/Area masters are supplied, use authenticated registration scope.
  const section = code==='HOD' ? 'ALL SECTIONS' : (u.section_department || NA);
  const area = code==='HOD' ? 'ALL AREAS' :
               code==='SECTION_INCHARGE' ? 'ALL AREAS' :
               (u.area_of_working || NA);

  await pool.query('BEGIN');
  try{
    await pool.query(
      `UPDATE user_responsibilities SET active=false
       WHERE employee_number=$1 AND active=true`,[employeeNumber]
    );
    await pool.query(
      `INSERT INTO user_responsibilities
       (employee_number,responsibility_role,scope_section,scope_area,assigned_by)
       VALUES($1,$2,$3,$4,$5)`,
      [employeeNumber,role,section,area,from]
    );
    await pool.query(
      `UPDATE users SET responsibility=$2,updated_at=now() WHERE employee_number=$1`,
      [employeeNumber,role]
    );
    await pool.query(
      `INSERT INTO authority_audit
       (employee_number,action,responsibility_role,scope_section,scope_area,performed_by)
       VALUES($1,'ASSIGN_RESPONSIBILITY',$2,$3,$4,$5)`,
      [employeeNumber,role,section,area,from]
    );
    await pool.query('COMMIT');
  }catch(e){ await pool.query('ROLLBACK'); throw e; }

  await syncDefaultAccess(employeeNumber,from,'Approved responsibility / hierarchy changed');
  await sendButtons(
    from,
    `Responsibility set\n${u.name} / ${employeeNumber}\n${role}\nSection: ${section}\nArea: ${area}`,
    [
      {id:`RESP_CHANGE:${employeeNumber}`,title:'Change'},
      {id:`ACCESS_PERMS:${employeeNumber}`,title:'Access Options'},
      {id:`RESP_DONE:${employeeNumber}`,title:'Done'}
    ]
  );
}


function validCompanyEmail(v=''){return /^[A-Z0-9._%+-]+@vizagsteel\.com$/i.test(String(v).trim());}
function cleanMax(v=''){const x=String(v).trim();return /^[0-9+\-()\/ ]{2,30}$/.test(x)?x:null;}
async function employeeSearch(term){
 const t=String(term||'').trim();if(!t)return[];
 if(/^\d+$/.test(t))return(await pool.query(`SELECT u.*,c.max_number,c.company_email FROM users u LEFT JOIN employee_contacts c USING(employee_number) WHERE u.employee_number=$1 AND u.approval_status='approved' AND u.is_active=true LIMIT 5`,[t])).rows;
 return(await pool.query(`SELECT u.*,c.max_number,c.company_email FROM users u LEFT JOIN employee_contacts c USING(employee_number) WHERE u.approval_status='approved' AND u.is_active=true AND LOWER(u.name) LIKE LOWER($1) ORDER BY u.name LIMIT 5`,[`%${t}%`])).rows;
}
async function profileText(u){
 const a=await effectiveAuthority(u.employee_number);
 const resp=(a?.responsibilities||[])[0]?.responsibility_role||u.responsibility||'Not found';
 return `${u.name}\nEmployee No: ${u.employee_number}\nDesignation: ${u.designation}\nSection: ${u.section_department}\nArea: ${u.area_of_working}\nResponsibility: ${resp}\nMAX No: ${u.max_number||'Not found'}\nCompany Email: ${u.company_email||'Not found'}`;
}
async function saveMax(from,emp,val){
 const u=await byEmp(emp),v=cleanMax(val);if(!u||u.approval_status!=='approved'||!u.is_active||!v)return false;
 await pool.query(`INSERT INTO employee_contacts(employee_number,max_number,entered_by) VALUES($1,$2,$3) ON CONFLICT(employee_number) DO UPDATE SET max_number=EXCLUDED.max_number,entered_by=EXCLUDED.entered_by,updated_at=now()`,[emp,v,from]);return true;
}
async function saveEmail(from,emp,val){
 const u=await byEmp(emp);if(!u||u.approval_status!=='approved'||!u.is_active||!validCompanyEmail(val))return false;
 await pool.query(`INSERT INTO employee_contacts(employee_number,company_email,entered_by) VALUES($1,$2,$3) ON CONFLICT(employee_number) DO UPDATE SET company_email=EXCLUDED.company_email,entered_by=EXCLUDED.entered_by,updated_at=now()`,[emp,String(val).toLowerCase(),from]);return true;
}
async function saveEmergency(from,name,val){
 const v=cleanMax(val),n=String(name).trim();if(!v||!n)return false;
 await pool.query(`INSERT INTO emergency_contacts(contact_name,max_number,entered_by) VALUES($1,$2,$3)`,[n,v,from]);return true;
}


function isoDate(v=''){
 const x=String(v??'').trim();
 if(!x)return null;
 let y,m,d;
 let a=x.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
 if(a){y=Number(a[1]);m=Number(a[2]);d=Number(a[3]);}
 else{
  a=x.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
  if(!a)return null;
  d=Number(a[1]);m=Number(a[2]);y=Number(a[3]);
 }
 const dt=new Date(Date.UTC(y,m-1,d));
 if(dt.getUTCFullYear()!==y||dt.getUTCMonth()!==m-1||dt.getUTCDate()!==d)return null;
 return `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function resolveUserDate(text='') {
 const t=String(text||'').trim().toLowerCase();
 const n=plantNow();
 if(/^(today|today's|ee roju|eroju|ఈరోజు|आज)$/.test(t)) return n.date;
 if(/^(yesterday|ninna|నిన్న|कल)$/.test(t)){ const d=new Date(n.date+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()-1); return d.toISOString().slice(0,10); }
 const m=String(text||'').match(/(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4})/);
 return m?isoDate(m[1]):null;
}
function normalizeMediaDates(obj={}){
 let invalid=false;
 const entries=(Array.isArray(obj.entries)?obj.entries:[]).map(e=>{
  if(!e||!e.event_date)return e;
  const source=String(e.event_date).trim();
  const normalized=isoDate(source);
  if(!normalized){invalid=true;return {...e,event_date_source:source,event_date:null};}
  return {...e,event_date_source:source,event_date:normalized};
 });
 return {obj:{...obj,entries,needs_event_time:Boolean(obj.needs_event_time||invalid)},invalid};
}
function isOperationsSection(u){
 return /operation|metallurgy/i.test(String(u?.section_department||''));
}
async function productionAuthority(u){
 if(!u)return {enter:false,modify:false};
 const owner=isOwner(u.whatsapp_number);
 const a=await effectiveAuthority(u.employee_number);
 const roles=(a?.responsibilities||[]).map(x=>String(x.responsibility_role||'').toLowerCase());
 const hod=roles.includes('hod');
 const opIncharge=isOperationsSection(u) && roles.some(r=>r.includes('in-charge')||r.includes('incharge'));
 const opShift=isOperationsSection(u) && roles.some(r=>r.includes('shift'));
 return {enter:owner||hod||opIncharge||opShift,modify:owner||hod||opIncharge};
}
async function productionSummary(date,area=null){
 const p=area?
   (await pool.query(`SELECT * FROM production_shift_logs WHERE production_date=$1 AND LOWER(area)=LOWER($2) AND deleted_at IS NULL ORDER BY shift,id`,[date,area])).rows:
   (await pool.query(`SELECT * FROM production_shift_logs WHERE production_date=$1 AND deleted_at IS NULL ORDER BY area,shift,id`,[date])).rows;
 if(!p.length)return 'Not found.';
 let out=[];
 for(const x of p){
   const ds=(await pool.query(`SELECT * FROM production_delays WHERE production_log_id=$1 AND deleted_at IS NULL ORDER BY id`,[x.id])).rows;
   out.push(`${x.production_date.toISOString().slice(0,10)} | ${x.area} | Shift ${x.shift}\nBlooms: ${x.blooms_rolled}\nEstimated: ${(x.blooms_rolled*4).toFixed(0)} t${x.operations_shift_incharge?`\nOperations Shift In-charge: ${x.operations_shift_incharge}`:''}${ds.length?'\nDelays:\n'+ds.map(d=>`${d.delay_section}: ${d.delay_minutes} min - ${d.reason}${d.job_action?` | Action: ${d.job_action}`:''}`).join('\n'):''}`);
 }
 return out.join('\n\n');
}


function plantNow(){
  // Render may run UTC; derive plant-local clock explicitly.
  const parts=new Intl.DateTimeFormat('en-CA',{
    timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
  }).formatToParts(new Date()).reduce((a,p)=>(a[p.type]=p.value,a),{});
  return {date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}:${parts.second}`,
          minutes:Number(parts.hour)*60+Number(parts.minute)};
}
function inferredPlantShift(mins){
  // Overlap belongs to the shift that is ending:
  // C/A: 06:00–06:30 => C, A/B: 14:00–14:30 => A, B/C: 22:00–22:30 => B.
  if(mins>=22*60 && mins<=22*60+30) return 'B';
  if(mins>22*60+30 || mins<6*60) return 'C';
  if(mins>=6*60 && mins<=6*60+30) return 'C';
  if(mins>6*60+30 && mins<=14*60+30) return 'A';
  if(mins>14*60+30 && mins<22*60) return 'B';
  return null;
}
function shiftToken(t=''){
  const m=String(t).trim().match(/^(?:i am in |today |duty )?([abc])\s*shift$/i);
  if(m)return m[1].toUpperCase();
  if(/^(general|general shift|g shift)$/i.test(String(t).trim()))return 'GENERAL';
  return null;
}
async function responsibilityName(emp){
  const a=await effectiveAuthority(emp);
  return (a?.responsibilities||[])[0]?.responsibility_role || 'Normal Employee';
}
async function setShiftCheckin(u,shift,from){
  const n=plantNow();
  await pool.query(`INSERT INTO user_shift_sessions(employee_number,duty_date,shift,checked_in_at,source)
    VALUES($1,$2,$3,now(),'explicit') ON CONFLICT(employee_number) DO UPDATE
    SET duty_date=EXCLUDED.duty_date,shift=EXCLUDED.shift,checked_in_at=now(),source='explicit',updated_at=now()`,
    [u.employee_number,n.date,shift]);
  await pool.query(`INSERT INTO employee_attendance(employee_number,duty_date,shift,check_in_at,entered_by,source)
    VALUES($1,$2,$3,now(),$4,'shift_checkin') ON CONFLICT(employee_number,duty_date,shift) DO NOTHING`,
    [u.employee_number,n.date,shift,from]);
}
async function currentShiftContext(u){
  const n=plantNow();
  const r=(await pool.query(`SELECT * FROM user_shift_sessions WHERE employee_number=$1 AND duty_date=$2 LIMIT 1`,
    [u.employee_number,n.date])).rows[0];
  if(r)return {shift:r.shift,source:'explicit_session'};
  const resp=(await responsibilityName(u.employee_number)).toLowerCase();
  if(resp.includes('general shift'))return {shift:'GENERAL',source:'responsibility'};
  return {shift:inferredPlantShift(n.minutes),source:'entry_time'};
}
async function saveSectionEvent(u,from,type,text,eventDate=null,eventShift=null,timingSource='entry_context',equipmentName=null,sourceMediaIngestionId=null){
  const n=plantNow(),ctx=await currentShiftContext(u),resp=await responsibilityName(u.employee_number);
  const d=eventDate?(isoDate(eventDate)||null):n.date,sh=eventShift||ctx.shift;
  if(!d)throw new Error(`Invalid event date: ${eventDate}`);
  const r=await pool.query(`INSERT INTO section_event_log(
    event_type,event_text,employee_number,employee_name,section,area,responsibility,event_date,event_shift,event_time,entered_by,timing_source,equipment_name,source_media_ingestion_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [type,text,u.employee_number,u.name,u.section_department,u.area_of_working,resp,d,sh,eventDate?null:n.time,from,timingSource,equipmentName,sourceMediaIngestionId]);
  return r.rows[0].id;
}
function looksLateOrUnclear(text=''){
  return /\b(earlier|previous|last shift|morning|afternoon|night|yesterday|day before|late entry|old)\b/i.test(text);
}
function classifySectionEvent(text=''){
  if(/\binspection|inspected|checked|observed\b/i.test(text))return 'inspection';
  if(/\bdefect|leak|loose|damage|damaged|abnormal|problem|fault|failed|failure\b/i.test(text))return 'defect';
  if(/\bjob|rectified|replaced|attended|repair|repaired|completed|action taken\b/i.test(text))return 'job_action';
  return null;
}

// V7.2 safety: terse nouns/search phrases are retrieval, never automatic data entry.
function looksLikeRetrievalIntent(text=''){
  const t=String(text||'').trim();
  if(/[?]$/.test(t))return true;
  if(/\b(show|find|search|list|history|details|data|records?|status|previous|old|tell|cheppu|chupinchu|entha|which|what|where|when)\b/i.test(t))return true;
  const words=t.split(/\s+/).filter(Boolean);
  const explicitEventVerb=/\b(is leaking|leaking|found|noticed|observed|has failed|failed at|damaged at|rectified|replaced|repaired|attended|completed|checked at|inspected at)\b/i.test(t);
  if(words.length<=5 && !explicitEventVerb)return true;
  if(/\b(defects?|jobs?|inspections?|breakdowns?|history|spares?|drawings?|manuals?|sop|smp)\b/i.test(t) && !explicitEventVerb)return true;
  return false;
}


function languageOf(t=''){
 const raw=String(t||'').trim();
 if(/[\u0C00-\u0C7F]/.test(raw))return 'te';
 if(/[\u0900-\u097F]/.test(raw))return 'hi';
 // V5.7.1: recognise common Roman-Telugu/Tenglish maintenance questions.
 // Technical English nouns (air valve, motor, bearing, etc.) may remain English,
 // but Telugu conversational words decide the reply language.
 const x=raw.toLowerCase().replace(/[^a-z0-9\s]/g,' ');
 const teWords=['gurunchi','gurinchi','cheppu','cheppandi','enti','enduku','endhuku','ela','ekkada','eppudu','emiti','emaina','kavali','kaavali','ivvu','ivvandi','chupinchu','chupinchandi','undha','unda','unnaya','undi','ledha','leda','naaku','naku','manaki','mana','dheeniki','deeniki','dani','dhani','yokka','tho','lo','nunchi','nundi','aithe','ayithe','chesaru','cheyyali','cheyali'];
 const words=x.split(/\s+/).filter(Boolean);
 if(words.some(w=>teWords.includes(w)))return 'te';
 return 'en';
}
function ml(lang,en,te,hi){return lang==='te'?te:lang==='hi'?hi:en;}
async function mediaMeta(id){
 const r=await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${id}`,{headers:{Authorization:`Bearer ${ACCESS_TOKEN}`}});
 if(!r.ok)throw new Error(`Meta media metadata ${r.status}`); return await r.json();
}
async function mediaBytes(url){
 const r=await fetch(url,{headers:{Authorization:`Bearer ${ACCESS_TOKEN}`}});
 if(!r.ok)throw new Error(`Meta media download ${r.status}`); return Buffer.from(await r.arrayBuffer());
}
function geminiInstruction(u,ctx){
 return `You are the document-intelligence ingestion engine for the LMMM steel-plant maintenance system.
FIRST understand what the source actually is. Never convert instructions/reference material into events that happened.
Return valid JSON only with this exact structure:
{"language":"en|te|hi","uncertain":boolean,"needs_event_time":boolean,"document_class":"manual|sop|smp|drawing|spares|inspection_record|defect_record|job_record|maintenance_history|vibration_readings|motor_load_readings|breakdown_delay|production|logbook|attendance|other_reference","document_kind":"table|handwritten_note|photo|audio|document","table_has_date_column":boolean,"title":string|null,"summary":string,"equipment_refs":[string],"identifiers":[string],"page_count":number|null,"reference_items":[{"heading":string|null,"text":string,"page_number":number|null,"page_end":number|null}],"entries":[{"type":"production|delay|inspection|defect|job_action|logbook_note|vibration_reading|motor_load_reading","equipment":string|null,"text":string,"blooms_rolled":number|null,"delay_minutes":number|null,"delay_section":string|null,"reason":string|null,"reading_value":number|null,"reading_unit":string|null,"reading_point":string|null,"event_date":string|null,"event_shift":"A|B|C|GENERAL|null"}]}.
DOCUMENT CLASSIFICATION IS MANDATORY.
Manual/SOP/SMP/drawing/spares/other_reference are REFERENCE documents. Put their useful content in reference_items and summary. Do NOT create inspection/job/defect/history entries merely because the manual says check, inspect, replace, maintain or lubricate. They have no event date unless the source explicitly records an action that actually happened. Set needs_event_time=false for pure reference documents.
For actual inspection/defect/job/history/vibration/motor-load/breakdown/production/logbook records, extract EVERY readable record. For TABLES bind each row's own Date + Equipment + description/readings/remarks to THAT SAME ROW. Different rows may have different dates/equipment. Never use a common date for a historical table. If one row date is unreadable, only that row gets event_date=null.
For fresh handwritten/current observations with no date, event_date=null and needs_event_time=true. User may later supply Today, Yesterday, DD/MM/YYYY, DD-MM-YYYY or YYYY-MM-DD.
Write entry.text in concise standard technical ENGLISH. Preserve exact visible equipment/SAP/CAT/drawing/part identifiers. Never guess unreadable identifiers. If mapping/classification is genuinely doubtful set uncertain=true.
Section=${u.section_department}; Area=${u.area_of_working}; Current shift=${ctx.shift||'unknown'}.`;
}
async function geminiGenerate(parts,u,ctx){
 if(!GEMINI_API_KEY)throw new Error('GEMINI_API_KEY missing');
 const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
 const body={
   system_instruction:{parts:[{text:geminiInstruction(u,ctx)}]},
   contents:[{role:'user',parts}],
   generationConfig:{temperature:0,responseMimeType:'application/json'}
 };
 const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 if(!r.ok)throw new Error(`Gemini ${r.status}: ${await r.text()}`);
 const j=await r.json();
 const txt=(j.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();
 if(!txt)throw new Error('Gemini returned no text');
 return parseAiJson(txt);
}
function parseAiJson(txt){
 let t=String(txt||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/```$/,'').trim();
 try{return JSON.parse(t);}catch(first){
   const a=t.indexOf('{'), b=t.lastIndexOf('}');
   if(a>=0&&b>a){try{return JSON.parse(t.slice(a,b+1));}catch(_e){}}
   const err=new Error(`AI_JSON_INCOMPLETE: ${first.message}`); err.code='AI_JSON_INCOMPLETE'; throw err;
 }
}
async function classifyExtracted(text,u,ctx){
 return geminiGenerate([{text:`Classify and extract every relevant LMMM entry from this message:\n${text}`}],u,ctx);
}
async function extractPhoto(buf,mime,u,ctx){
 return geminiGenerate([
   {text:'Read this shift log-book/photo carefully. If it is a table, extract EVERY readable row and keep the date from that same row attached to that entry. Do not skip Date/Equipment/Job Description/Remarks columns. If handwritten, extract every readable maintenance observation. Mark uncertain=true only for genuinely doubtful handwriting/identifiers.'},
   {inline_data:{mime_type:mime||'image/jpeg',data:buf.toString('base64')}}
 ],u,ctx);
}
async function extractAudio(buf,mime,u,ctx){
 return geminiGenerate([
   {text:'Transcribe/understand this voice or audio message and extract every relevant LMMM entry. Detect Telugu, English or Hindi and preserve technical identifiers exactly.'},
   {inline_data:{mime_type:mime||'audio/ogg',data:buf.toString('base64')}}
 ],u,ctx);
}

async function geminiUploadFile(buf,mime,name='document'){
 if(!GEMINI_API_KEY)throw new Error('GEMINI_API_KEY missing');
 const start=await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(GEMINI_API_KEY)}`,{
  method:'POST',headers:{'Content-Type':'application/json','X-Goog-Upload-Protocol':'resumable','X-Goog-Upload-Command':'start','X-Goog-Upload-Header-Content-Length':String(buf.length),'X-Goog-Upload-Header-Content-Type':mime||'application/octet-stream'},
  body:JSON.stringify({file:{display_name:String(name||'document').slice(0,200)}})
 });
 if(!start.ok)throw new Error(`Gemini file start ${start.status}: ${await start.text()}`);
 const uploadUrl=start.headers.get('x-goog-upload-url'); if(!uploadUrl)throw new Error('Gemini upload URL missing');
 const up=await fetch(uploadUrl,{method:'POST',headers:{'Content-Length':String(buf.length),'X-Goog-Upload-Offset':'0','X-Goog-Upload-Command':'upload, finalize'},body:buf});
 if(!up.ok)throw new Error(`Gemini file upload ${up.status}: ${await up.text()}`);
 let out=await up.json(); let f=out.file||out;
 for(let i=0;i<30 && f?.state==='PROCESSING';i++){
  await new Promise(r=>setTimeout(r,2000));
  const gr=await fetch(`https://generativelanguage.googleapis.com/v1beta/${f.name}?key=${encodeURIComponent(GEMINI_API_KEY)}`);
  if(gr.ok)f=await gr.json();
 }
 if(f?.state==='FAILED')throw new Error('Gemini file processing failed');
 if(!f?.uri)throw new Error('Gemini file URI missing');
 return f;
}
function geminiFilePart(file,mime){return {file_data:{mime_type:mime||file?.mimeType||'application/pdf',file_uri:file.uri}};}
async function withRetry(fn,attempts=3){let last;for(let i=0;i<attempts;i++){try{return await fn(i);}catch(e){last=e;if(i+1<attempts)await new Promise(r=>setTimeout(r,1200*(i+1)));}}throw last;}
async function classifyDocumentGate(buf,mime,u,ctx,name='',sourcePart=null){
 // HARD ROUTING GATE: classify the whole document before any event extraction.
 // This prevents imperative words in manuals (check/inspect/replace) from becoming completed events.
 const gate=await geminiGenerate([
   {text:`DOCUMENT TYPE GATE ONLY. Classify the WHOLE source, not individual sentences. Filename: ${name}. If the source is an operation/maintenance instruction manual, O&M/OMI, SOP, SMP, drawing, catalogue or spare/reference document, document_class MUST be the corresponding reference class and needs_event_time=false. Instructions such as "check filter", "inspect", "lubricate", "replace" are NOT evidence that work happened. For this gate return entries=[]; use title/summary/equipment_refs/identifiers/reference_items only.`},
   sourcePart||{inline_data:{mime_type:mime,data:buf.toString('base64')}}
 ],u,ctx);
 return gate||{};
}
async function extractDocument(buf,mime,u,ctx,name='',sourcePart=null){
 const gate=await classifyDocumentGate(buf,mime,u,ctx,name,sourcePart);
 const referenceClasses=new Set(['manual','sop','smp','drawing','spares','other_reference']);
 if(referenceClasses.has(gate.document_class)){
   // Reference path is terminal: never send this document through event/history extraction.
   // V5.7: first get reliable document metadata/page count. Full knowledge extraction is done page-range by page-range later.
   const detail=await geminiGenerate([
     {text:`REFERENCE DOCUMENT METADATA PASS. The hard gate classified this source as ${gate.document_class}. Determine the exact title, total page_count, equipment_refs and exact identifiers. Give only a concise overall summary; do NOT attempt to squeeze the whole manual into reference_items. Keep document_class exactly "${gate.document_class}". entries=[]; needs_event_time=false. Filename: ${name}.`},
     sourcePart||{inline_data:{mime_type:mime,data:buf.toString('base64')}}
   ],u,ctx);
   return {...detail,document_class:gate.document_class,needs_event_time:false,entries:[],uncertain:false,title:detail?.title||gate.title||null,summary:detail?.summary||gate.summary||'',equipment_refs:detail?.equipment_refs||gate.equipment_refs||[],identifiers:detail?.identifiers||gate.identifiers||[],page_count:Number(detail?.page_count||gate?.page_count||0)||null,reference_items:[]};
 }
 const detail=await geminiGenerate([
   {text:`EVENT/RECORD EXTRACTION. The hard document gate classified this source as ${gate.document_class||'unknown record'}. Extract actual recorded events/readings row-by-row. Each row keeps its own date and equipment. Do not turn instructions into events. Preserve exact identifiers. Filename: ${name}.`},
   sourcePart||{inline_data:{mime_type:mime,data:buf.toString('base64')}}
 ],u,ctx);
 // Gate owns top-level class; downstream extraction cannot silently change it.
 return {...detail,document_class:gate.document_class||detail.document_class,title:detail?.title||gate.title||null};
}

async function extractReferenceRange(buf,mime,u,ctx,obj,name,startPage,endPage,sourcePart=null){
 return geminiGenerate([
  {text:`FULL REFERENCE KNOWLEDGE EXTRACTION. Read ONLY pages ${startPage}-${endPage} of this ${obj.document_class} (${obj.title||name}). Extract ALL useful maintenance knowledge from those pages without summarising away technical detail: headings, operating instructions, maintenance instructions, specifications, values/units, tolerances/clearances, lubrication, troubleshooting, warnings, spare/part numbers, drawing references, item/equipment identifiers and notes. Preserve exact identifiers and numeric values. Every reference_items item MUST include its source page_number (and page_end if it spans pages). Do not create historical events. entries=[]; needs_event_time=false. If a page has multiple distinct sections, return multiple reference_items. Do not include content from pages outside ${startPage}-${endPage}.`},
  sourcePart||{inline_data:{mime_type:mime,data:buf.toString('base64')}}
 ],u,ctx);
}
async function checkpoint(mediaId,unitType,start,end,status,error=null){
 await pool.query(`INSERT INTO ingestion_checkpoints(media_ingestion_id,unit_type,unit_start,unit_end,status,attempts,last_error,updated_at)
 VALUES($1,$2,$3,$4,$5,1,$6,now()) ON CONFLICT(media_ingestion_id,unit_type,unit_start,unit_end)
 DO UPDATE SET status=EXCLUDED.status,attempts=ingestion_checkpoints.attempts+1,last_error=EXCLUDED.last_error,updated_at=now()`,[mediaId,unitType,start,end,status,error?String(error).slice(0,1500):null]);
}
async function indexFullReferenceDocument(mediaRowId,knowledgeId,buf,mime,u,from,obj,name,sourcePart=null){
 const total=Math.max(1,Math.min(Number(obj.page_count)||1,5000)),step=total>80?5:10; let chunkCount=0; const failedPages=[],indexed=new Set();
 const unitType=/tiff?/i.test(mime)||/\.tiff?$/i.test(name)?'frame':'page';
 async function savePart(part,start,end){
   const items=Array.isArray(part?.reference_items)?part.reference_items:[];
   for(const item of items){const text=String(item?.text||'').trim();if(!text)continue;const ps=Math.max(start,Math.min(end,Number(item.page_number)||start)),pe=Math.max(ps,Math.min(end,Number(item.page_end)||ps));
    await pool.query(`INSERT INTO technical_document_chunks(media_ingestion_id,knowledge_id,employee_number,document_class,title,equipment_name,identifiers,page_start,page_end,section_heading,content_text,source_filename,entered_by) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13 WHERE NOT EXISTS(SELECT 1 FROM technical_document_chunks WHERE media_ingestion_id=$1 AND page_start=$8 AND page_end=$9 AND coalesce(section_heading,'')=coalesce($10,'') AND content_text=$11)`,[mediaRowId,knowledgeId,u.employee_number,obj.document_class,obj.title||name,(obj.equipment_refs||[])[0]||null,JSON.stringify(obj.identifiers||[]),ps,pe,item.heading||null,text,name,from]);
    chunkCount++;for(let p=ps;p<=pe;p++)indexed.add(p);
   }
 }
 async function onePage(p){
   await checkpoint(mediaRowId,unitType,p,p,'processing');
   try{const ctx=await currentShiftContext(u);const part=await withRetry(()=>extractReferenceRange(buf,mime,u,ctx,obj,name,p,p,sourcePart),4);await savePart(part,p,p);indexed.add(p);await checkpoint(mediaRowId,unitType,p,p,'done');return true;}
   catch(e){console.error(`[REFERENCE ${unitType.toUpperCase()} ${p}]`,e);failedPages.push(p);await checkpoint(mediaRowId,unitType,p,p,'review',e.message);return false;}
 }
 for(let start=1;start<=total;start+=step){
   const end=Math.min(total,start+step-1); await checkpoint(mediaRowId,unitType,start,end,'processing');
   try{const ctx=await currentShiftContext(u);const part=await withRetry(()=>extractReferenceRange(buf,mime,u,ctx,obj,name,start,end,sourcePart),3);await savePart(part,start,end);await checkpoint(mediaRowId,unitType,start,end,'done');for(let p=start;p<=end;p++)if(!indexed.has(p))await onePage(p);}
   catch(e){console.error(`[REFERENCE RANGE ${start}-${end}]`,e);await checkpoint(mediaRowId,unitType,start,end,'fallback',e.message);for(let p=start;p<=end;p++)await onePage(p);}
 }
 const uniqFail=[...new Set(failedPages)].filter(p=>!indexed.has(p)).sort((a,b)=>a-b),failedRanges=[];for(const p of uniqFail){const last=failedRanges.at(-1);if(last&&last[1]===p-1)last[1]=p;else failedRanges.push([p,p]);}
 return {total,indexedPages:total-uniqFail.length,attemptedPages:total,chunkCount,failedPages:uniqFail.length,failedRanges};
}


function naturalSearchAliases(q=''){
  let x=String(q).trim();
  // Deterministic user-language aliases only. Never rewrite stored identifiers.
  x=x.replace(/\bfurnace\s*[- ]?1\b/ig,'WBF-1').replace(/\bfurnace\s*[- ]?2\b/ig,'WBF-2');
  x=x.replace(/\bwalking\s+beam\s+furnace\s*[- ]?1\b/ig,'WBF-1').replace(/\bwalking\s+beam\s+furnace\s*[- ]?2\b/ig,'WBF-2');
  // Conservative maintenance-intent typo normalization. This changes only search intent words, never asset/part/drawing IDs.
  x=x.replace(/\b(?:dectives?|defectives?|difects?|deffects?)\b/ig,'defects');
  x=x.replace(/\b(?:viberation|vibrtion|vibratoin)s?\b/ig,'vibration');
  x=x.replace(/\b(?:maintainance|maintanance)\b/ig,'maintenance');
  x=x.replace(/\b(?:histroy|histry)\b/ig,'history');
  x=x.replace(/\b(?:produciton|prodution)\b/ig,'production');
  return x;
}
async function syncBundledLmmmKnowledge(){
  try{
    const meta=(await pool.query(`SELECT sync_key,record_count FROM lmmm_master_sync_meta WHERE sync_key IN ('core-v75-clean1','unified-v4')`)).rows;
    const have=new Map(meta.map(x=>[x.sync_key,Number(x.record_count)]));
    if(have.get('core-v75-clean1')!==23088){
      const rows=JSON.parse(await fs.readFile(new URL('./data/master_core_records.json',import.meta.url),'utf8'));
      await pool.query(`INSERT INTO lmmm_master_records(uid,record_type,equipment,area,event_date,record_text,source_name,source_payload)
        SELECT x.uid,x.record_type,NULLIF(x.equipment,''),NULLIF(x.area,''),NULLIF(x.event_date,''),x.text,x.source,x.payload
        FROM jsonb_to_recordset($1::jsonb) AS x(uid text,record_type text,equipment text,area text,event_date text,text text,source text,payload jsonb)
        ON CONFLICT(uid) DO UPDATE SET record_type=EXCLUDED.record_type,equipment=EXCLUDED.equipment,area=EXCLUDED.area,event_date=EXCLUDED.event_date,record_text=EXCLUDED.record_text,source_name=EXCLUDED.source_name,source_payload=EXCLUDED.source_payload`,[JSON.stringify(rows)]);
      await pool.query(`INSERT INTO lmmm_master_sync_meta(sync_key,record_count,synced_at) VALUES('core-v75-clean1',$1,now()) ON CONFLICT(sync_key) DO UPDATE SET record_count=EXCLUDED.record_count,synced_at=now()`,[rows.length]);
      console.log('[V7.5 MASTER SYNC] core',rows.length);
    }
    if(have.get('unified-v4')!==10805){
      const rows=JSON.parse(await fs.readFile(new URL('./data/unified_retrieval_records.json',import.meta.url),'utf8'));
      await pool.query(`INSERT INTO lmmm_knowledge_records(uid,source_name,source_row,entity_types,raw_text,normalized_text,identifiers,verification_status,source_payload)
        SELECT x.uid,x.source_file,x.source_row,x.entity_types,x.raw_text,x.normalized_text,x.identifiers,x.verification_status,to_jsonb(x)
        FROM jsonb_to_recordset($1::jsonb) AS x(uid text,source_file text,source_row text,entity_types text[],raw_text text,normalized_text text,identifiers text[],verification_status text)
        ON CONFLICT(uid) DO UPDATE SET raw_text=EXCLUDED.raw_text,normalized_text=EXCLUDED.normalized_text,identifiers=EXCLUDED.identifiers,entity_types=EXCLUDED.entity_types,verification_status=EXCLUDED.verification_status`,[JSON.stringify(rows)]);
      await pool.query(`INSERT INTO lmmm_master_sync_meta(sync_key,record_count,synced_at) VALUES('unified-v4',$1,now()) ON CONFLICT(sync_key) DO UPDATE SET record_count=EXCLUDED.record_count,synced_at=now()`,[rows.length]);
      console.log('[V7.5 MASTER SYNC] unified',rows.length);
    }
  }catch(e){console.error('[V7.5 MASTER SYNC ERROR]',e);}
}
async function searchBundledMaster(question,limit=20,dateRange=null,offset=0){
  const q=naturalSearchAliases(question), intent=searchIntent(q), entity=stripIntentWords(q);
  const vals=[]; let where='TRUE';
  if(intent==='defect'){vals.push('defect');where+=` AND record_type=$${vals.length}`;}
  else if(intent==='history'){vals.push('history');where+=` AND record_type=$${vals.length}`;}
  else if(intent==='spares'){vals.push('spare');where+=` AND record_type=$${vals.length}`;}
  // Jobs in the clean master are represented inside maintenance-history records; live job_action rows are merged separately.
  else if(intent==='job_action'){vals.push('history');where+=` AND record_type=$${vals.length}`;}
  const terms=queryTokens(entity||q).slice(0,6);
  if(terms.length){
    // All entity terms must be represented, but punctuation variants are normalized by naturalSearchAliases first.
    for(const t of terms){vals.push(`%${t}%`);where+=` AND (LOWER(COALESCE(equipment,'')) LIKE LOWER($${vals.length}) OR LOWER(record_text) LIKE LOWER($${vals.length}))`;}
  }
  if(dateRange?.from){vals.push(dateRange.from);where+=` AND CASE WHEN event_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN event_date::date END >= $${vals.length}::date`;}
  if(dateRange?.to){vals.push(dateRange.to);where+=` AND CASE WHEN event_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN event_date::date END <= $${vals.length}::date`;}
  vals.push(limit); const limP=vals.length; vals.push(Math.max(0,Number(offset)||0)); const offP=vals.length;
  const rows=(await pool.query(`SELECT uid,record_type,equipment,area,event_date,record_text,source_name,source_payload FROM lmmm_master_records WHERE ${where} ORDER BY CASE WHEN event_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN event_date::date END DESC NULLS LAST, uid LIMIT $${limP} OFFSET $${offP}`,vals)).rows;
  if(rows.length)return rows;
  const ids=[...new Set(String(q).toUpperCase().match(/\b(?:[A-Z]{1,8}[-_/])?[A-Z0-9]{2,}(?:[-_/.][A-Z0-9]+)*\b/g)||[])];
  const kt=queryTokens(q).slice(0,5); if(!ids.length&&!kt.length)return [];
  const kv=[];const kc=[];
  if(ids.length){kv.push(ids);kc.push(`identifiers && $1::text[]`);}
  for(const t of kt){kv.push(`%${t}%`);kc.push(`LOWER(normalized_text) LIKE LOWER($${kv.length})`);}
  kv.push(limit);
  return (await pool.query(`SELECT uid,'knowledge' AS record_type,NULL::text AS equipment,NULL::text AS area,NULL::text AS event_date,raw_text AS record_text,source_name,'{}'::jsonb AS source_payload FROM lmmm_knowledge_records WHERE ${kc.join(' OR ')} LIMIT $${kv.length}`,kv)).rows;
}
function formatBundledResults(rows){
  if(!rows?.length)return null;
  return rows.map(r=>{
    const p=r.source_payload||{};
    const detail=p.description||p.job||p.job_done||p.remarks||p.reason||r.record_text||'';
    const extra=[];
    if(p.subeq && String(p.subeq).toLowerCase()!=='nan')extra.push(`Sub-equipment: ${p.subeq}`);
    if(p.remarks && String(p.remarks).toLowerCase()!=='nan' && String(p.remarks)!==String(detail))extra.push(`Remarks: ${p.remarks}`);
    const h=[r.event_date,r.equipment,r.record_type].filter(Boolean).join(' | ');
    const shared=r._shared_note?`\nScope: ${r._shared_note}`:'';
    return `${h?`${h}\n`:''}${String(detail).slice(0,700)}${extra.length?'\n'+extra.join('\n'):''}${shared}${r.source_name?`\nSource: ${r.source_name}`:''}`;
  }).join('\n\n');
}

function queryTokens(t=''){
 return [...new Set(String(t).toLowerCase().replace(/[^a-z0-9_\-\/\.\s]/g,' ').split(/\s+/).filter(x=>x.length>=2 && !['the','and','for','with','what','tell','about','show','give','please','data','details','lo','ki','ga','ani'].includes(x)))].slice(0,12);
}
// V7.4 user-first universal maintenance search. Never guess a specific asset when several match.
const GENERIC_ASSET_WORDS=/\b(pump|pumps|gear\s*box|gearbox|gearboxes|coupling|couplings|motor|motors|bearing|bearings|valve|valves|pipe|pipes|pipeline|stand|stands|roll|rolls|guide|guides|cylinder|cylinders|fan|fans|blower|blowers|recup|recuperator|compressor|compressors)\b/i;
function dateRangeFromText(q=''){
 const t=String(q||'').toLowerCase().trim(), now=plantNow().date;
 const d0=new Date(now+'T00:00:00Z'), iso=d=>d.toISOString().slice(0,10);
 const explicit=[...String(q||'').matchAll(/(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4})/g)].map(m=>isoDate(m[1])).filter(Boolean);
 if(explicit.length>=2)return {from:explicit[0],to:explicit[1],label:`${explicit[0]} to ${explicit[1]}`};
 if(explicit.length===1)return {from:explicit[0],to:explicit[0],label:explicit[0]};
 if(/\btoday\b|ee roju|eroju/.test(t))return {from:now,to:now,label:'Today'};
 if(/\byesterday\b|ninna/.test(t)){const d=new Date(d0);d.setUTCDate(d.getUTCDate()-1);return {from:iso(d),to:iso(d),label:'Yesterday'};}
 let m=t.match(/last\s+(\d+)\s+days?/); if(m){const d=new Date(d0);d.setUTCDate(d.getUTCDate()-Math.max(0,Number(m[1])-1));return {from:iso(d),to:now,label:`Last ${m[1]} days`};}
 if(/\blast\s+7\s+days?|last week\b/.test(t)){const d=new Date(d0);d.setUTCDate(d.getUTCDate()-6);return {from:iso(d),to:now,label:'Last 7 days'};}
 if(/\blast\s+30\s+days?/.test(t)){const d=new Date(d0);d.setUTCDate(d.getUTCDate()-29);return {from:iso(d),to:now,label:'Last 30 days'};}
 if(/\bthis month\b/.test(t))return {from:now.slice(0,7)+'-01',to:now,label:'This month'};
 const months={jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12};
 m=t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(20\d{2})\b/);
 if(m){const y=Number(m[2]),mo=months[m[1]],last=new Date(Date.UTC(y,mo,0)).getUTCDate();return {from:`${y}-${String(mo).padStart(2,'0')}-01`,to:`${y}-${String(mo).padStart(2,'0')}-${last}`,label:`${m[1]} ${y}`};}
 return null;
}
function wantsOverall(q=''){return /\b(full|all|overall|complete|total|entire)\b/i.test(String(q||''));}
function wantsMore(q=''){return /^(more|next|next 20|show more)$/i.test(String(q||'').trim());}
function isDateOnlyCommand(q=''){
 const t=String(q||'').trim();
 if(/^(today|yesterday|last\s+\d+\s+days?|last week|this month)$/i.test(t))return true;
 const ds=[...t.matchAll(/(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4})/g)];
 return ds.length>=1 && /^(?:\s*(?:from\s*)?)?(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4})(?:\s*(?:to|[-–—])\s*(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4}))?\s*$/i.test(t);
}
async function clearSearchDates(u){
 await pool.query(`UPDATE search_context SET date_from=NULL,date_to=NULL,page_offset=0,updated_at=now() WHERE employee_number=$1`,[u.employee_number]);
}
function areaDataQuery(q=''){return /\b(area|bdm|bar mill|finishing)\b/i.test(String(q||'')) && /\b(full|all|overall|complete|data|records?)\b/i.test(String(q||'')) && !/\b(wbf|furnace|equipment|gearbox|motor|pump|shear|door|recup|recuperator)\b/i.test(String(q||''));}
async function setSearchFilters(u,{module,dateFrom,dateTo,offset,lastQuery}={}){
 await pool.query(`UPDATE search_context SET module=COALESCE($2,module),date_from=COALESCE($3,date_from),date_to=COALESCE($4,date_to),page_offset=COALESCE($5,page_offset),last_query=COALESCE($6,last_query),updated_at=now() WHERE employee_number=$1`,[u.employee_number,module||null,dateFrom||null,dateTo||null,Number.isInteger(offset)?offset:null,lastQuery||null]);
}
function cleanScopeValue(v=''){const x=String(v||'').trim();return (!x||/^not assigned$/i.test(x))?'':x;}
async function effectiveSearchScope(u){
 const a=await effectiveAuthority(u.employee_number); if(!a)return null;
 const ps=new Set((a.special_permissions||[]).map(x=>String(x).toUpperCase()));
 const roles=(a.responsibilities||[]).map(x=>String(x.responsibility_role||'').toLowerCase());
 const plantWide=isOwner(u?.whatsapp_number)||a.scope==='PLANT_WIDE'||ps.has('SUPER_ADMIN')||ps.has('OWNER');
 const sections=new Set(),areas=new Set();
 const rs=cleanScopeValue(a.registered_section),ra=cleanScopeValue(a.registered_area); if(rs)sections.add(rs);if(ra)areas.add(ra);
 for(const r of (a.responsibilities||[])){const ss=cleanScopeValue(r.scope_section),sa=cleanScopeValue(r.scope_area);if(ss)sections.add(ss);if(sa)areas.add(sa);}
 const jobScopes=new Set();
 for(const r of (a.assignments||[])){
   const ss=cleanScopeValue(r.section),sa=cleanScopeValue(r.area); if(ss)sections.add(ss);if(sa)areas.add(sa);
   const js=String(r.job_scope||'ALL').trim().toUpperCase(); if(js)jobScopes.add(js);
 }
 return {plantWide,department_code:'35',sections:[...sections],areas:[...areas],jobScopes:[...jobScopes],authority:a,roles};
}
function scopeKey(v=''){return String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function scopeTokens(v=''){return scopeKey(v).split(/\s+/).filter(Boolean);}
// Department-35 hierarchy bridge. These are scope relationships, not renames of canonical equipment.
// Keep this deliberately small and explicit; unknown relationships are never guessed.
const DEPT35_SCOPE_CHILDREN={
  'bdm':['bdm','wbf','wbf 1','wbf 2','walking beam furnace','furnace 1','furnace 2','ecs','evaporative cooling system'],
  'bar mill':['bar mill'],
  'finishing':['finishing']
};
function scopeAreaMatches(scopeArea,recordArea='',equipment=''){
 const s=scopeKey(scopeArea), a=scopeKey(recordArea), e=scopeKey(equipment);
 if(!s)return false;
 if(s==='all areas'||s==='all')return true;
 if(a && (a===s||a.includes(s)||s.includes(a)))return true;
 const children=DEPT35_SCOPE_CHILDREN[s]||[];
 if(children.some(c=>a===c||a.includes(c)||e===c||e.includes(c)))return true;
 // Equipment master sometimes stores WBF as equipment while the user's registered parent area is BDM.
 if((s==='bdm'||s.includes('bdm')) && (/^wbf [12]$/.test(e)||/walking beam furnace/.test(e)||a.includes('wbf')||a.includes('furnace')||a.includes('ecs')))return true;
 return false;
}
function areaMatchesScope(area,scope,equipment=''){
 if(!scope||scope.plantWide)return true;
 if(!scope.areas?.length)return true;
 return scope.areas.some(x=>scopeAreaMatches(x,area,equipment));
}
async function searchPermissions(u){
 const a=await effectiveAuthority(u.employee_number);
 const legacyPs=new Set((a?.special_permissions||[]).map(x=>String(x).toUpperCase()));
 const override=!!a?.has_access_override;
 // Once Super Admin applies a profile, this snapshot is the ONLY feature-right source.
 const ps=new Set((override?(a?.override_permissions||[]):[...legacyPs]).map(x=>String(x).toUpperCase()));
 // Owner/Super Admin is determined from the approved user's WhatsApp number and always has full controls.
 const owner=isOwner(u?.whatsapp_number);
 const scope=await effectiveSearchScope(u);
 const inherited=new Set((a?.default_permissions||[]).map(x=>String(x.permission||'').toUpperCase()));
 const effective=override?new Set([...ps]):new Set([...inherited,...ps]);
 // IMPORTANT: when override=true, hierarchy/default permissions are intentionally ignored.
 // A Super Admin downgrade therefore removes inherited FULL/REPORT/PDF/ANALYSIS capabilities immediately.
 const full=owner || effective.has('FULL_ACCESS') || effective.has('SUPER_ADMIN') || effective.has('OWNER');
 const canEdit=full || effective.has('EDIT') || effective.has('ENTRY');
 const canView=full || canEdit || effective.has('VIEW');
 const advanced=full || effective.has('ANALYSIS') || effective.has('ADVANCED_REPORTS');
 const reports=full || effective.has('REPORTS') || effective.has('ADVANCED_REPORTS');
 const js=new Set((scope?.jobScopes||[]).map(x=>String(x).toUpperCase()));
 const unrestricted=full || !js.size || js.has('ALL') || js.has('NOT ASSIGNED');
 const jobAllowed=(...names)=>unrestricted || names.some(n=>js.has(n));
 return {
   owner, full, scope,
   view: canView,
   edit: canEdit,
   entry: canEdit,
   more: canView,
   date: canView,
   analysis: advanced,
   reports,
   repeat: advanced && jobAllowed('DEFECTS','JOBS','HISTORY'),
   jobs: canView && jobAllowed('JOBS','HISTORY'),
   history: canView && jobAllowed('HISTORY','JOBS','DEFECTS'),
   mtbf: advanced,
   performance: advanced && jobAllowed('DEFECTS','JOBS','HISTORY','PM','INSPECTION_CBM','BREAKDOWN'),
   pm: canView && jobAllowed('PM'),
   cbm: canView && jobAllowed('INSPECTION_CBM'),
   delay: advanced && jobAllowed('BREAKDOWN'),
   pdf: full || effective.has('PRINT_EXPORT') || effective.has('PDF_REPORT') || effective.has('ADVANCED_REPORTS'),
   rcm: full || effective.has('RCM')
 };
}
async function primarySearchButtons(u,hasMore=true){
 const perms=await searchPermissions(u);
 const b=[{id:'SEARCH_DATA_MENU',title:'Select Data'}];
 if(hasMore && perms.more)b.push({id:'SEARCH_MORE',title:'More'});
 if(perms.analysis)b.push({id:'SEARCH_ANALYSIS',title:'Analysis'});
 else if(perms.date)b.push({id:'SEARCH_DATE',title:'Date Range'});
 return b.slice(0,3);
}
function allowedAnalysisRows(perms){
 const rows=[];
 if(perms.repeat)rows.push({id:'AN_REPEAT',title:'Repeat Failures'});
 if(perms.jobs)rows.push({id:'AN_JOBS',title:'Related Jobs'});
 if(perms.history)rows.push({id:'AN_HISTORY',title:'Equipment History'});
 if(perms.mtbf)rows.push({id:'AN_MTBF',title:'MTBF / MTTR'});
 if(perms.performance)rows.push({id:'AN_PERF',title:'Equipment Performance'});
 if(perms.pm)rows.push({id:'AN_PM',title:'Scheduled Maintenance'});
 if(perms.cbm)rows.push({id:'AN_CBM',title:'Vibration / CBM'});
 if(perms.delay)rows.push({id:'AN_DELAY',title:'Delay Impact'});
 if(perms.rcm)rows.push({id:'AN_RCM',title:'RCM Analysis'});
 if(perms.pdf)rows.push({id:'AN_PDF',title:'PDF Report',description:'Printable A4 report for current results'});
 return rows;
}
function actionFooter(){ return ''; }
async function areaSearchMenu(q,u){
 const scope=await effectiveSearchScope(u);
 const area=String(q).replace(/\b(full|all|overall|complete|data|records?|details?)\b/ig,' ').replace(/\s+/g,' ').trim();
 if(scope && !scope.plantWide && scope.areas?.length && !areaMatchesScope(area,scope)) return {text:'This area is outside your authorised work scope.'};
 await pool.query(`INSERT INTO search_context(employee_number,department_code,area,equipment_name,module,date_from,date_to,page_offset,updated_at) VALUES($1,'35',$2,NULL,NULL,NULL,NULL,0,now()) ON CONFLICT(employee_number) DO UPDATE SET area=EXCLUDED.area,equipment_name=NULL,module=NULL,date_from=NULL,date_to=NULL,page_offset=0,updated_at=now()`,[u.employee_number,area||null]);
 return {text:`${area||'Area'} — Maintenance Data\n\n1. Search by Equipment\n2. Select Date / Date Range`};
}
function searchIntent(q=''){
 const t=String(q).toLowerCase();
 if(/\b(defect|defects|fault|faults|problem|problems)\b/.test(t))return 'defect';
 if(/\b(job|jobs|work\s*order|maintenance\s*job)\b/.test(t))return 'job_action';
 if(/\b(inspection|condition|vibration|cbm)\b/.test(t))return 'condition';
 if(/\b(shutdown)\b/.test(t))return 'shutdown';
 if(/\b(history|previous|old|past)\b/.test(t))return 'history';
 if(/\b(spare|spares|inventory|stock)\b/.test(t))return 'spares';
 if(/\b(job\s*procedure|procedure|how\s+to|steps|method|replacement\s+procedure|overhaul\s+procedure)\b/.test(t))return 'procedure';
 if(/\b(drawing|drawings|drg|drawing\s*(?:no|number)|part\s*drawing)\b/.test(t))return 'drawing';
 if(/\b(production|blooms|tonnes?|tons?)\b/.test(t))return 'production';
 if(/\b(delay|delays|downtime)\b/.test(t))return 'delay';
 if(/\b(mtbf|mtbr|mttr|performance|availability)\b/.test(t))return 'analysis';
 if(/\b(pm|preventive|schedule|scheduled|rcm|reliability)\b/.test(t))return 'maintenance';
 return 'general';
}
function stripIntentWords(q=''){
 // Date/range tokens are filters, never equipment/entity search terms.
 return String(q)
  .replace(/\b(defects?|faults?|problems?|jobs?|work\s*orders?|history|previous|old|past|inspection|condition|monitoring|vibration|cbm|shutdown|spares?|inventory|stock|drawings?|drg|drawing\s*(?:no|number)|part\s*drawing|job\s*procedure|procedure|steps|method|how\s+to|manuals?|details?|about|tell|show|find|search|cheppu|gurinchi|pm|preventive|scheduled?|maintenance|rcm|reliability)\b/ig,' ')
  .replace(/\b(?:from|to)\b/ig,' ')
  .replace(/(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4})/g,' ')
  .replace(/\s+/g,' ').trim();
}
async function getSearchContext(u){return (await pool.query(`SELECT * FROM search_context WHERE employee_number=$1`,[u.employee_number])).rows[0]||null;}
async function setSearchContext(u,equipment,area=null){await pool.query(`INSERT INTO search_context(employee_number,department_code,area,equipment_name,updated_at) VALUES($1,'35',$2,$3,now()) ON CONFLICT(employee_number) DO UPDATE SET area=COALESCE(EXCLUDED.area,search_context.area),equipment_name=EXCLUDED.equipment_name,updated_at=now()`,[u.employee_number,area,equipment]);}
async function resolveAlias(term){if(!term)return null;const r=await pool.query(`UPDATE search_aliases SET usage_count=usage_count+1,last_used_at=now() WHERE department_code='35' AND confirmed=TRUE AND LOWER(alias_text)=LOWER($1) RETURNING canonical_text,equipment_name`,[term]);return r.rows[0]||null;}
async function equipmentCandidates(term,ctx){
 const vals=[], clauses=[]; let n=1;
 const add=(x)=>{vals.push(`%${x}%`);return `$${n++}`};
 if(term){const p=add(term);clauses.push(`LOWER(name) LIKE LOWER(${p})`);}
 if(!clauses.length)return [];
 const contextArea=ctx?.area?String(ctx.area):null;
 vals.push(contextArea); const areaP=`$${n++}::text`;
 // Explicit ::text prevents PostgreSQL 42P08 when the optional area context is NULL.
 // Include the V7.5 clean master as an equipment source so Universal Search is not limited to event/manual tables.
 const sql=`WITH eq AS (\n   SELECT DISTINCT equipment_name AS name, area FROM section_event_log WHERE deleted_at IS NULL AND equipment_name IS NOT NULL\n   UNION SELECT DISTINCT equipment_name AS name, NULL::text AS area FROM technical_document_chunks WHERE equipment_name IS NOT NULL\n   UNION SELECT DISTINCT equipment AS name, area FROM lmmm_master_records WHERE equipment IS NOT NULL\n ) SELECT name,area FROM eq WHERE (${clauses.join(' OR ')})\n ORDER BY CASE WHEN ${areaP} IS NOT NULL AND LOWER(COALESCE(area,''))=LOWER(${areaP}) THEN 0 ELSE 1 END, name LIMIT 12`;
 return (await pool.query(sql,vals)).rows;
}
async function eventSearch(q,u,equipment=null,dateRange=null){
 const intent=searchIntent(q), terms=queryTokens(stripIntentWords(q)); const vals=[]; let where=`deleted_at IS NULL`;
 if(dateRange?.from){vals.push(dateRange.from);where+=` AND event_date >= $${vals.length}::date`;}
 if(dateRange?.to){vals.push(dateRange.to);where+=` AND event_date <= $${vals.length}::date`;}
 if(equipment){vals.push(equipment);where+=` AND (LOWER(COALESCE(equipment_name,''))=LOWER($${vals.length}) OR LOWER(event_text) LIKE LOWER('%'||$${vals.length}||'%'))`;}
 for(const t of terms.slice(0,5)){vals.push(t);where+=` AND LOWER(event_text||' '||COALESCE(equipment_name,'')) LIKE LOWER('%'||$${vals.length}||'%')`;}
 if(intent==='defect'||intent==='job_action'){vals.push(intent);where+=` AND event_type=$${vals.length}`;}
 const r=await pool.query(`SELECT id,event_type,equipment_name,event_date,event_shift,event_text FROM section_event_log WHERE ${where} ORDER BY event_date DESC,entered_at DESC LIMIT 12`,vals);
 return r.rows;
}
function normalizedSearchPhrase(s=''){
 return naturalSearchAliases(String(s)).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
function usefulLiveEvent(row,original){
 const text=normalizedSearchPhrase(row?.event_text||'');
 const query=normalizedSearchPhrase(original||'');
 if(!text)return false;
 // A retrieval phrase accidentally saved as an event (for example "Furnace-2 defects") must never mask real history.
 if(text===query)return false;
 if(/^(wbf|furnace)\s*[12]\s*(defect|defects|job|jobs|history)?$/.test(text))return false;
 return true;
}
function formatLiveEvents(rows){
 return rows.slice(0,8).map(x=>`${x.event_date?.toISOString?.().slice(0,10)||x.event_date} | ${x.event_type}${x.event_shift?` | ${x.event_shift}`:''}\n${x.event_text}`).join('\n\n');
}
// V7.7.5 context-aware Analysis Action Router.
// Analysis menu selections are actions on the active equipment/date context, never fresh search phrases.
function analysisActionName(q=''){
 const t=String(q||'').trim().toLowerCase().replace(/[_-]+/g,' ');
 if(['an repeat','repeat failures','repeat failure'].includes(t))return 'repeat';
 if(['an jobs','related jobs','jobs done'].includes(t))return 'jobs';
 if(['an history','equipment history'].includes(t))return 'history';
 if(['an mtbf','mtbf / mttr','mtbf/mttr','mtbf','mttr','mtbr'].includes(t))return 'mtbf';
 if(['an perf','equipment performance','performance'].includes(t))return 'performance';
 if(['an pm','scheduled maintenance','schedule maintenance','pm'].includes(t))return 'pm';
 if(['an cbm','vibration / cbm','vibration/cbm','vibration','cbm'].includes(t))return 'cbm';
 if(['an delay','delay impact','breakdown / delay impact'].includes(t))return 'delay';
 if(['an pdf','pdf report','pdf analysis report'].includes(t))return 'pdf';
 if(['an rcm','rcm analysis','rcm'].includes(t))return 'rcm';
 return null;
}
function ctxRange(ctx){return ctx?.date_from?{from:String(ctx.date_from).slice(0,10),to:String(ctx.date_to||ctx.date_from).slice(0,10)}:null;}
function failureFingerprint(r){
 const p=r?.source_payload||{};
 let raw=String(p.description||p.reason||p.defect||r?.record_text||'').toUpperCase();
 // Remove source/remarks/action tails so the failure itself drives grouping.
 raw=raw.split(/\b(?:REMARKS?|ACTION|ATTENDED|RECTIFIED|REPLACED|REPLACEMENT|WELDING DONE|GREASING DONE|SOURCE)\s*[:|-]?/)[0];
 const componentRules=[
  ['DOOR',/\b(?:DISH(?:CHARGE)?\.?\s*)?DOOR(?:S)?(?:\s*[-#]?\s*\d+)?\b/],
  ['RECUPERATOR',/\bRECUP(?:ERATOR)?(?:S)?(?:\s*[-#]?\s*\d+)?\b/],
  ['ECS PUMP',/\bECS\s*[- ]?\d*.*?\bPUMP(?:S)?\b|\bPUMP(?:S)?\b.*?\bECS\s*[- ]?\d*\b/],
  ['CAF',/\bCAF(?:\s*[- ]?[12S])?\b/],
  ['COUPLING',/\bCOUPLING\b/],['BEARING',/\b(?:BEARING|BRG|P\/?B)\b/],
  ['GEARBOX',/\bGEAR\s*BOX|GEARBOX\b/],['VALVE',/\bVALVE\b/],
  ['PIPE/HEADER',/\b(?:PIPE|HEADER|BEND|FLANGE)\b/],['HOSE',/\bHOSE\b/],
  ['BURNER',/\bBURNER\b/],['FAN/BLOWER',/\b(?:FAN|BLOWER)\b/]
 ];
 const modeRules=[
  ['LEAK',/\b(?:LEAK|LEAKAGE|PUNCTURE|BURST)\w*\b/],
  ['VIBRATION HIGH',/\bVIBR\w*\b.{0,60}\b(?:HIGH|INCREAS|ABNORMAL|MAX)\w*\b|\b(?:HIGH|INCREAS|ABNORMAL)\w*\b.{0,60}\bVIBR\w*\b/],
  ['DAMAGED/BROKEN',/\b(?:DAMAGE|DAMAGED|BROKEN|CRACK|CRACKED|WORN|WEAR|FAILED|FAILURE)\b/],
  ['LOOSE',/\b(?:LOOSE|SLACK)\b/],['JAM',/\b(?:JAM|JAMMED|STUCK)\b/],
  ['FLOW/PRESSURE LOW',/\b(?:FLOW|PRESSURE)\b.{0,50}\b(?:LOW|LESS|DROP)\w*\b/],
  ['OVERHEAT',/\b(?:OVERHEAT|HOT|TEMPERATURE HIGH)\w*\b/],
  ['MISALIGNMENT',/\b(?:MISALIGN|ALIGNMENT OUT)\w*\b/]
 ];
 const comp=(componentRules.find(([,re])=>re.test(raw))||[])[0]||'';
 const mode=(modeRules.find(([,re])=>re.test(raw))||[])[0]||'';
 // Preserve explicit asset/location identity when present so unrelated valves/doors/lines are not merged.
 const ids=[];
 for(const re of [/\b(?:DOOR|VALVE|BURNER|PUMP|FAN|BLOWER|RECUPERATOR|RECUP|SKID|ZONE|Z|LINE|HEADER)\s*(?:NO\.?|#)?\s*[- ]?(\d+)\b/ig,/\b(?:L|LEVEL)\s*[- ]?(\d+)\b/ig]){let m;while((m=re.exec(raw))&&ids.length<3)ids.push(m[0].replace(/\s+/g,' ').trim());}
 const ident=[...new Set(ids)].join(' / ');
 if(comp&&mode){const label=`${comp}${ident?` [${ident}]`:''} — ${mode}`;return {key:label,label,confidence:ident?'asset-mode':'pattern'};}
 // Conservative normalized fallback: enough detail to avoid merging unrelated defects.
 let x=raw.replace(/\b(?:NO|NUMBER)\s*[-#]?\s*\d+\b/g,' NO')
   .replace(/\b\d+(?:\.\d+)?\s*(?:MM|CM|M|BAR|KG|AMP|A|V)\b/g,' VALUE')
   .replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim();
 const stop=new Set(['THE','A','AN','IS','ARE','WAS','WERE','TO','OF','IN','AT','FROM','AND','FOR','FOUND','OBSERVED']);
 x=x.split(' ').filter(z=>z&&!stop.has(z)).slice(0,14).join(' ');
 return x?{key:x,label:x,confidence:'exact-normalized'}:null;
}
function normFailureText(r){const f=failureFingerprint(r);return f?f.key:'';}
function repeatFailureGroups(rows){
 const m=new Map();
 for(const r of rows){const f=failureFingerprint(r);if(!f?.key)continue;const a=m.get(f.key)||{label:f.label,confidence:f.confidence,rows:[]};a.rows.push(r);m.set(f.key,a);}
 return [...m.values()].filter(g=>g.rows.length>1).sort((a,b)=>b.rows.length-a.rows.length);
}
function analysisEquipmentKeys(eq=''){
 const raw=String(eq||'').trim(), n=scopeKey(raw), out=new Set([n]);
 // Retrieval aliases only. Canonical stored equipment names/IDs are never changed.
 const m=n.match(/^(?:wbf|furnace|walking beam furnace)\s*([12])$/);
 if(m){
   const k=m[1];
   ['wbf '+k,'wbf'+k,'furnace '+k,'furnace'+k,'walking beam furnace '+k].forEach(x=>out.add(scopeKey(x)));
   // Explicit Dept-35 parent/child aliases: selecting a furnace must include its own auxiliaries.
   // These are retrieval aliases only; canonical equipment names are never rewritten.
   ['ecs '+k,'ecs'+k,'caf '+k,'caf'+k].forEach(x=>out.add(scopeKey(x)));
 }
 // Conservative punctuation/spacing variants for every equipment name (BDM, FART, ECS-1, TOCB, etc.).
 if(n){
   out.add(n.replace(/\s+/g,''));
   out.add(n.replace(/\bno\s+(\d+)\b/g,'$1'));
   const tail=n.match(/^(.*?)(?:\s+)(\d+)$/);
   if(tail){out.add(scopeKey(`${tail[1]}-${tail[2]}`));out.add(scopeKey(`${tail[1]}${tail[2]}`));}
 }
 return [...out].filter(Boolean);
}
function explicitLegacyEventDate(r){
 const direct=String(r?.event_date||'').trim();
 if(/^\d{4}-\d{2}-\d{2}$/.test(direct))return direct;
 const text=String(r?.record_text||r?.source_payload?.text||'');
 let m=text.match(/\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})(?:\s+00:00:00)?\b/);
 if(m)return `${m[1]}-${m[2]}-${m[3]}`;
 m=text.match(/\b(\d{1,2})[\/.](\d{1,2})[\/.]((?:19|20)\d{2})\b/);
 if(m){const d=Number(m[1]),mo=Number(m[2]),y=Number(m[3]);if(d>=1&&d<=31&&mo>=1&&mo<=12)return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;}
 return '';
}
function analysisRowMatchesEquipment(r,keys=[]){
 const eq=scopeKey(r?.equipment||'');
 if(eq && keys.some(k=>k && (eq===k || eq.replace(/\s+/g,'')===k.replace(/\s+/g,''))))return true;
 // Legacy Maintenance History rows often have blank equipment columns. Match explicit equipment aliases in source-backed text.
 const hay=scopeKey(`${r?.record_text||''} ${r?.source_payload?.text||''} ${r?.source_name||''}`);
 return keys.some(k=>{
   if(!k)return false;
   const esc=k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   if(new RegExp(`(?:^| )${esc}(?: |$)`).test(hay))return true;
   const compact=k.replace(/\s+/g,'');
   return compact.length>=4 && hay.replace(/\s+/g,'').includes(compact);
 });
}
function sharedEquipmentNote(r,selected=''){
 const hay=scopeKey(`${r?.equipment||''} ${r?.record_text||''} ${r?.source_payload?.text||''}`);
 const s=scopeKey(selected);
 if(!s)return '';
 // Only flag explicit multi-equipment wording; do not split or rewrite the original record.
 const multi=/\b(?:and|&|both)\b/.test(String(r?.record_text||'').toLowerCase()) &&
   /(wbf|furnace|ecs|bdm|mill|shear|door|pump|gearbox)/i.test(String(r?.record_text||''));
 return multi ? 'Shared/combined equipment record' : '';
}
function isJobHistoryRow(r){
 const p=r?.source_payload||{};
 const s=String(`${p.job||''} ${p.job_done||''} ${p.action||''} ${p.remarks||''} ${r?.record_text||''}`).toLowerCase();
 return /\b(replac(?:e|ed|ement)|repair(?:ed)?|rectif(?:y|ied)|attend(?:ed)?|weld(?:ed|ing)?|tighten(?:ed|d)?|greas(?:e|ed|ing)|lubricat(?:e|ed|ion)|overhaul(?:ed)?|dismantl(?:e|ed|ing)|assembl(?:e|ed|y)|install(?:ed|ation)?|align(?:ed|ment)?|chang(?:e|ed)|clean(?:ed|ing)|adjust(?:ed|ment)?|renew(?:ed|al)|servic(?:e|ed|ing)|work done|job done)\b/i.test(s);
}
function explicitDurationMinutes(r){
 const p=r?.source_payload||{};
 const s=String(`${p.duration||''} ${p.downtime||''} ${p.delay||''} ${r?.record_text||''}`);
 let m=s.match(/\b(?:downtime|delay|duration|restoration time|repair time)\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*(min|mins|minutes|hr|hrs|hour|hours)\b/i);
 if(!m)return null;
 const v=Number(m[1]); if(!Number.isFinite(v)||v<0)return null;
 return /^h/i.test(m[2])?v*60:v;
}
async function rowsForContext(ctx,type=null,limit=500,u=null){
 if(!ctx?.equipment_name)return [];
 const perms=u?await searchPermissions(u):null;
 const keys=(perms?.full||perms?.owner)?analysisEquipmentKeys(ctx.equipment_name):[scopeKey(ctx.equipment_name)];
 const vals=[];let w='TRUE';
 if(type){vals.push(type);w+=` AND record_type=$${vals.length}`;}
 // Fetch source-backed candidates first. Legacy history has blank equipment/event_date columns,
 // so equipment/date filtering is completed safely in JS from explicit row text.
 vals.push(Math.max(5000,Math.min(15000,Number(limit||500)*12)));
 let rows=(await pool.query(`SELECT uid,record_type,equipment,area,event_date,record_text,source_name,source_payload FROM lmmm_master_records WHERE ${w} ORDER BY CASE WHEN event_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN event_date::date END DESC NULLS LAST,uid LIMIT $${vals.length}`,vals)).rows;
 rows=rows.filter(r=>analysisRowMatchesEquipment(r,keys));
 rows=rows.map(r=>{const note=sharedEquipmentNote(r,ctx.equipment_name);return note?{...r,_shared_note:note}:r;});
 const dr=ctxRange(ctx);
 rows=rows.map(r=>{const d=explicitLegacyEventDate(r);return d&&!r.event_date?{...r,event_date:d}:r;});
 if(dr?.from)rows=rows.filter(r=>r.event_date && r.event_date>=dr.from);
 if(dr?.to)rows=rows.filter(r=>r.event_date && r.event_date<=dr.to);
 if(u){const sc=await effectiveSearchScope(u);rows=rows.filter(r=>areaMatchesScope(r.area,sc,r.equipment||r.record_text));}
 rows.sort((a,b)=>String(b.event_date||'').localeCompare(String(a.event_date||''))||String(a.uid||'').localeCompare(String(b.uid||'')));
 return rows.slice(0,Math.max(1,Number(limit)||500));
}
function analysisText(r){return String(`${r?.record_text||''} ${JSON.stringify(r?.source_payload||{})} ${r?.source_name||''}`);}
function isTrueCbmRow(r){
 const p=r?.source_payload||{}, t=analysisText(r);
 if(['vibration_reading','motor_load_reading'].includes(String(r?.record_type||'').toLowerCase()))return true;
 if(/WBF CONDITION MONITORING|VIBRATIONS ALL|condition monitoring/i.test(String(r?.source_name||'')))return /vibr|mm\/s|mm\/sec|m\/s2|µm|micron|bearing temp|temperature|axial|vertical|horizontal|\bDE\b|\bNDE\b/i.test(t);
 // History is CBM evidence only when an actual measured value/measurement statement is present.
 return /(vibr(?:ation|n)?\s*(?:level|reading|value)?|bearing\s*temp|temperature).{0,80}(\d+(?:\.\d+)?\s*(?:mm\/s|mm\/sec|m\/s2|°?c|deg\s*c|micron|µm)|increased|high|low|reduced)/i.test(t)
   || /\d+(?:\.\d+)?\s*(?:mm\/s|mm\/sec|m\/s2|micron|µm).{0,80}(?:vibr|vertical|horizontal|axial|DE|NDE)/i.test(t);
}
function isTruePmRow(r){
 const p=r?.source_payload||{},t=analysisText(r);
 if(String(r?.record_type||'').toLowerCase()==='pm')return true;
 if(/preventive maintenance|PM schedule|scheduled maintenance/i.test(String(r?.source_name||'')))return true;
 if(/^PM$/i.test(String(p.category||'')))return true;
 // A phrase such as "preventive measure" in a defect/job history is NOT proof of a scheduled PM task.
 return /\bpreventive maintenance\b|\bplanned maintenance\b|\bscheduled maintenance\b|\bPM\s*(?:done|schedule|job|inspection)\b/i.test(t);
}
function isDelayEvidenceRow(r){
 const t=analysisText(r),p=r?.source_payload||{};
 if(['delay','breakdown_delay','breakdown'].includes(String(r?.record_type||'').toLowerCase()))return true;
 if(Number.isFinite(Number(p.delay_minutes))&&Number(p.delay_minutes)>0)return true;
 return /\b(?:delay(?:ed)?|downtime|breakdown|stoppage)\b.{0,80}\b\d+(?:\.\d+)?\s*(?:min|mins|minutes|hr|hrs|hours|shift|shifts)\b/i.test(t)
   || /\b\d+(?:\.\d+)?\s*(?:min|mins|minutes|hr|hrs|hours|shift|shifts)\b.{0,80}\b(?:delay|downtime|breakdown|stoppage)\b/i.test(t);
}
async function liveAnalysisRows(ctx,u){
 const keys=analysisEquipmentKeys(ctx.equipment_name),dr=ctxRange(ctx),vals=[];let w=`deleted_at IS NULL`;
 if(dr?.from){vals.push(dr.from);w+=` AND event_date >= $${vals.length}::date`;}
 if(dr?.to){vals.push(dr.to);w+=` AND event_date <= $${vals.length}::date`;}
 vals.push(3000);const rows=(await pool.query(`SELECT 'LIVE:'||id::text uid,event_type record_type,equipment_name equipment,area,event_date::text,event_text record_text,'Live LMMM Entry' source_name,jsonb_build_object('event_shift',event_shift,'event_time',event_time,'status',status) source_payload FROM section_event_log WHERE ${w} ORDER BY event_date DESC,entered_at DESC LIMIT $${vals.length}`,vals)).rows;
 const sc=await effectiveSearchScope(u);
 return rows.filter(r=>analysisRowMatchesEquipment(r,keys)&&areaMatchesScope(r.area,sc,r.equipment||r.record_text));
}
async function technicalAnalysisRows(ctx,u){
 const keys=analysisEquipmentKeys(ctx.equipment_name),vals=[5000];
 const rows=(await pool.query(`SELECT 'DOC:'||id::text uid,LOWER(COALESCE(document_class,'knowledge')) record_type,equipment_name equipment,NULL::text area,NULL::text event_date,COALESCE(section_heading||' — ','')||content_text record_text,source_filename source_name,jsonb_build_object('document_class',document_class,'page_start',page_start,'page_end',page_end,'title',title) source_payload FROM technical_document_chunks ORDER BY id DESC LIMIT $1`,vals)).rows;
 return rows.filter(r=>analysisRowMatchesEquipment(r,keys));
}
async function allAnalysisRows(ctx,u,limit=6000){
 const [master,live,docs]=await Promise.all([rowsForContext(ctx,null,limit,u),liveAnalysisRows(ctx,u),technicalAnalysisRows(ctx,u)]);
 const seen=new Set(),out=[];
 for(const r of [...live,...master,...docs]){const k=scopeKey(`${r.event_date||''}|${r.equipment||''}|${r.record_text||''}`);if(!k||seen.has(k))continue;seen.add(k);out.push(r);}
 out.sort((a,b)=>String(b.event_date||'').localeCompare(String(a.event_date||'')));
 return out;
}
function performanceSummary(rows){
 const defects=rows.filter(r=>String(r.record_type).toLowerCase()==='defect');
 const hist=rows.filter(r=>String(r.record_type).toLowerCase()==='history');
 const jobs=rows.filter(isJobHistoryRow);
 const cbm=rows.filter(isTrueCbmRow);
 const delays=rows.filter(isDelayEvidenceRow);
 const pm=rows.filter(isTruePmRow);
 const dated=rows.filter(r=>/^\d{4}-\d{2}-\d{2}$/.test(String(r.event_date||''))).map(r=>r.event_date).sort();
 const repeats=repeatFailureGroups(defects);
 const latest=dated.length?dated[dated.length-1]:'Not available',first=dated.length?dated[0]:'Not available';
 const top=repeats.slice(0,3).map(g=>`${g.label} (${g.rows.length})`).join('; ');
 return {defects,hist,jobs,cbm,delays,pm,latest,first,repeats,top};
}

function pdfSafeText(v=''){return String(v??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/[^\x20-\x7E]/g,'?').replace(/\s+/g,' ').trim();}
function officialEventEligible(r,code){
 const eventCodes=new Set(['DEFECTS','JOBS','HISTORY','PM','CBM','BREAKDOWN']);
 if(!eventCodes.has(code))return true;
 return /^\d{4}-\d{2}-\d{2}$/.test(String(r?.event_date||''));
}
function currentReportCodes(ctx,selected=[]){
 if(selected?.length)return selected.filter(c=>DATA_MENU_OPTIONS.some(x=>x[0]===c));
 const m=String(ctx?.module||'').toLowerCase();
 if(m==='defect')return ['DEFECTS']; if(m==='job_action')return ['JOBS']; if(m==='history')return ['HISTORY'];
 if(m==='condition')return ['CBM']; if(m==='delay')return ['BREAKDOWN']; if(m==='spares'||m==='drawing'||m==='procedure')return ['SPARES'];
 return ['DEFECTS','JOBS','HISTORY','PM','CBM','BREAKDOWN','SPARES'];
}
async function buildMaintenancePdf(ctx,u,codes){
 let PDFDocument,StandardFonts,rgb;
 ({PDFDocument,StandardFonts,rgb}=await import('pdf-lib'));
 const all=await allAnalysisRows(ctx,u,12000), dr=ctxRange(ctx), pdf=await PDFDocument.create();
 const font=await pdf.embedFont(StandardFonts.Helvetica), bold=await pdf.embedFont(StandardFonts.HelveticaBold);
 const MAX_ROWS=200;
 // A4 print layout: portrait by default; landscape only when the selected report needs wider columns.
 const wideReport=codes.length>1 || codes.some(c=>['SPARES','CBM'].includes(c));
 const W=wideReport?841.89:595.28,H=wideReport?595.28:841.89,M=24,FS=wideReport?6.2:6.0,LH=8.0; let page,y;
 const cols=wideReport?[26,48,86,70,390,150]:[24,48,76,62,255,82]; // No, Date, Equipment, Type, Details/Action, Source
 const xs=[M]; for(let i=0;i<cols.length-1;i++)xs.push(xs[i]+cols[i]);
 function addPage(){page=pdf.addPage([W,H]);y=H-M;page.drawText('LMMM AI Maintenance - Verified Record List',{x:M,y,font:bold,size:12});y-=17;}
 function txt(v){return pdfSafeText(v||'');}
 function fit(v,n){const t=txt(v);return t.length<=n?t:t.slice(0,Math.max(1,n-3))+'...';}
 function header(){
   const names=['No.','Date','Equipment','Type','Defect / Job / History / Details','Source'];
   page.drawRectangle({x:M,y:y-12,width:W-2*M,height:14,borderWidth:0.5,borderColor:rgb(0,0,0),color:rgb(0.92,0.92,0.92)});
   names.forEach((n,i)=>page.drawText(n,{x:xs[i]+2,y:y-9,font:bold,size:FS})); y-=14;
 }
 function wrapCell(v,maxChars,maxLines=4){
   const words=txt(v).split(/\s+/).filter(Boolean),lines=[];let line='';
   for(const w of words){const next=line?line+' '+w:w;if(next.length<=maxChars)line=next;else{if(line)lines.push(line);line=w;if(lines.length>=maxLines-1)break;}}
   if(line&&lines.length<maxLines)lines.push(line);
   const original=txt(v);if(lines.join(' ').length<original.length&&lines.length)lines[lines.length-1]=fit(lines[lines.length-1],Math.max(4,maxChars-3))+'...';
   return lines.length?lines:[''];
 }
 function row(cells){
   const lens=wideReport?[5,10,14,12,82,30]:[5,10,12,10,54,17];
   const wrapped=cells.map((c,i)=>wrapCell(c,lens[i],i===4?4:2));
   const lineCount=Math.max(...wrapped.map(x=>x.length));const h=Math.max(18,6+lineCount*8);
   if(y<M+h+20){addPage();header();}
   page.drawRectangle({x:M,y:y-h,width:W-2*M,height:h,borderWidth:0.35,borderColor:rgb(0.55,0.55,0.55)});
   for(let i=1;i<xs.length;i++)page.drawLine({start:{x:xs[i],y},end:{x:xs[i],y:y-h},thickness:0.3,color:rgb(0.65,0.65,0.65)});
   wrapped.forEach((lines,i)=>lines.forEach((line,j)=>page.drawText(line,{x:xs[i]+2,y:y-10-j*8,font,size:FS})));
   y-=h;
 }
 addPage();
 page.drawText(`Equipment: ${txt(ctx.equipment_name||'LMMM')} | Dept: 35 | Period: ${dr?`${dr.from} to ${dr.to}`:'All available'}`,{x:M,y,font:bold,size:8});y-=12;
 page.drawText(`Generated: ${new Date().toISOString()} | Requested by: ${txt(u.employee_number||'')}`,{x:M,y,font,size:7});y-=15;
 let totalEligible=0,totalExcluded=0,remaining=MAX_ROWS,n=0; const prepared=[];
 for(const code of codes){
   const raw=dataRowsForCode(all,code); const good=raw.filter(r=>officialEventEligible(r,code)); totalEligible+=good.length;totalExcluded+=raw.length-good.length;
   for(const r of good){if(remaining<=0)break;prepared.push({code,r});remaining--;}
   if(remaining<=0)break;
 }
 page.drawText(`Showing ${prepared.length} of ${totalEligible} validated matching record(s). ${totalExcluded} excluded/review-required. Maximum 200 rows per PDF report.`,{x:M,y,font:bold,size:7.3});y-=16;header();
 for(const x of prepared){n++;const r=x.r,p=r.source_payload||{};const detail=p.description||p.job||p.job_done||p.remarks||p.reason||r.record_text||'';row([String(n),r.event_date||'',r.equipment||ctx.equipment_name||'',String(r.record_type||x.code).toUpperCase(),detail,r.source_name||'Stored LMMM record']);}
 if(totalEligible>prepared.length){if(y<M+42)addPage();y-=5;page.drawText(`Note: ${totalEligible-prepared.length} additional validated matching record(s) are not included because this PDF report is capped at 200 rows. Use Date Range or a narrower data selection for the next report.`,{x:M,y,font:bold,size:7});}
 return {buffer:Buffer.from(await pdf.save()),included:prepared.length,eligible:totalEligible,excluded:totalExcluded};
}
async function sendCurrentMaintenancePdf(to,u){
 const perms=await searchPermissions(u);
 if(!perms.pdf){await sendText(to,'PDF / Print is not authorised for your current access level.');return {denied:true};}
 const ctx=await getSearchContext(u);if(!ctx?.equipment_name){await sendText(to,'Select/search an equipment first.');return;}
 const st=await selectionGet(u.employee_number,'EQUIPMENT_DATA',ctx.equipment_name,[]);const codes=currentReportCodes(ctx,st.context?.applied?st.selected:[]);
 await sendText(to,`${ctx.equipment_name} printable A4 PDF report is being prepared (up to 200 validated matching records).`);
 const out=await buildMaintenancePdf(ctx,u,codes);const safe=String(ctx.equipment_name).replace(/[^A-Za-z0-9_-]+/g,'_').slice(0,40)||'LMMM';
 await sendDocumentBuffer(to,out.buffer,`${safe}_Maintenance_Report.pdf`,`Printable A4 maintenance report • ${out.included}/${out.eligible} shown • ${out.excluded} review/excluded • ${codes.join(', ')}`,'application/pdf');
}

async function analysisAction(q,u){
 const action=analysisActionName(q); if(!action)return null;
 const ctx=await getSearchContext(u); if(!ctx?.equipment_name)return {text:'Select an equipment first, then open Analysis.'};
 const perms=await searchPermissions(u);
 const actionPerm={repeat:'repeat',jobs:'jobs',history:'history',mtbf:'mtbf',performance:'performance',pm:'pm',cbm:'cbm',delay:'delay',pdf:'pdf',rcm:'rcm'}[action];
 if(actionPerm && !perms[actionPerm])return {text:'This option is not authorised for your access level.'};
 const eq=ctx.equipment_name,dr=ctxRange(ctx),period=dr?` | ${dr.from} to ${dr.to}`:'';
 const all=await allAnalysisRows(ctx,u,6000);
 if(action==='repeat'){
   const rows=all.filter(r=>String(r.record_type).toLowerCase()==='defect'); if(!rows.length)return {text:`${eq}${period}\nNo defect records found in the current filters.`};
   const groups=repeatFailureGroups(rows).slice(0,15);
   if(!groups.length)return {text:`${eq}${period}\nNo repeat-failure pattern could be confirmed from the current filtered defect records.`};
   const body=groups.map((g,i)=>{const vd=g.rows.map(x=>String(x.event_date||'')).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d));const bad=g.rows.length-vd.length;return `${i+1}. ${g.label}\nOccurrences: ${g.rows.length}\nValid dates: ${vd.slice(0,6).join(', ')||'None'}${vd.length>6?' …':''}${bad?`\nDate review required: ${bad} record(s)`:''}`;}).join('\n\n');
   return {text:`${eq} — Repeat Failures${period}\n\n${body}\n\nGrouping uses explicit asset/location + failure mode where available. If an exact asset identifier is absent, the result is a recurring failure pattern, not proof that the same physical component failed repeatedly. Stored records and identifiers are never rewritten.`,buttons:await primarySearchButtons(u,false)};
 }
 if(action==='jobs'||action==='history'){
   let rows=all.filter(r=>String(r.record_type).toLowerCase()==='history'||String(r.record_type).toLowerCase()==='job_action');
   if(action==='jobs')rows=rows.filter(r=>String(r.record_type).toLowerCase()==='job_action'||isJobHistoryRow(r));
   if(!rows.length)return {text:`${eq}${period}\nNo ${action==='jobs'?'explicit related-job':'maintenance-history'} records found in the current filters.`};
   return {text:`${eq} — ${action==='jobs'?'Related Jobs':'Equipment History'}${period}\n\n${formatBundledResults(rows.slice(0,20))}`,buttons:await primarySearchButtons(u,rows.length>20)};
 }
 if(action==='cbm'){
   const rows=all.filter(isTrueCbmRow);
   return {text:rows.length?`${eq} — Vibration / CBM${period}\n\n${formatBundledResults(rows.slice(0,20))}`:`${eq}${period}\nNo actual vibration/CBM measurement records were found in the currently indexed data. Maintenance text containing only the word “vibration” is not shown as a reading.`,buttons:await primarySearchButtons(u,rows.length>20)};
 }
 if(action==='pm'){
   const rows=all.filter(isTruePmRow);
   return {text:rows.length?`${eq} — Scheduled / Preventive Maintenance${period}\n\n${formatBundledResults(rows.slice(0,20))}`:`${eq}${period}\nNo confirmed PM/scheduled-maintenance records were found. Ordinary defect/job records such as greasing are not automatically labelled as scheduled PM.`,buttons:await primarySearchButtons(u,rows.length>20)};
 }
 if(action==='delay'){
   const rows=all.filter(isDelayEvidenceRow);
   return {text:rows.length?`${eq} — Breakdown / Delay Evidence${period}\n\n${formatBundledResults(rows.slice(0,20))}`:`${eq}${period}\nNo explicit breakdown/delay-duration evidence was found in the current filtered data.`,buttons:await primarySearchButtons(u,rows.length>20)};
 }
 if(action==='mtbf'){
   const defects=all.filter(r=>String(r.record_type).toLowerCase()==='defect');
   const valid=defects.filter(r=>/^\d{4}-\d{2}-\d{2}$/.test(String(r.event_date||'')));
   const durations=all.map(explicitDurationMinutes).filter(x=>Number.isFinite(x));
   const mttr=durations.length?`MTTR from ${durations.length} records with explicit stored repair/downtime duration: ${(durations.reduce((a,b)=>a+b,0)/durations.length/60).toFixed(2)} hours`:'MTTR: Not available — no reliable stored failure-to-restoration duration was found.';
   return {text:`${eq} — MTBF / MTTR${period}\n\nDefect records: ${defects.length}\nRecords with valid event dates: ${valid.length}\n\nMTBF: Not available — validated operating time and failure-start data are incomplete. Defect-to-defect interval is not reported as MTBF.\n${mttr}\n\nOnly explicit stored timing is used; 00:00:00 date placeholders and missing values are not treated as failure/restoration times.`};
 }
 if(action==='performance'){
   const x=performanceSummary(all);
   const span=x.first==='Not available'?'Not available':`${x.first} to ${x.latest}`;
   return {text:`${eq} — Equipment Performance${period}\n\nUnique linked records analysed: ${all.length}\nDefect records: ${x.defects.length}\nMaintenance-history records: ${x.hist.length}\nJob/action evidence (overlapping subset): ${x.jobs.length}\nConfirmed CBM/vibration evidence: ${x.cbm.length}\nConfirmed scheduled/PM records: ${x.pm.length}\nBreakdown/delay evidence: ${x.delays.length}\nData period: ${span}\nRecurring failure-pattern groups: ${x.repeats.length}${x.top?`\nTop recurring patterns: ${x.top}`:''}\n\nCounts can overlap because one historical record may contain job, CBM or delay evidence. Availability, MTBF and MTTR are shown only when validated timing inputs exist; missing KPI inputs are not inferred.`};
 }
 if(action==='pdf'){await sendCurrentMaintenancePdf(u.whatsapp_number,u);return {handled:true};}
 if(action==='rcm')return {text:`${eq}${period}\nRCM Analysis requires linked failure modes, consequences, existing tasks and historical evidence. The bot will not generate an unsupported RCM conclusion from defect counts alone.`};
 return null;
}
async function universalSearch(q,u){
 const rawOriginal=String(q||'').trim(); if(!rawOriginal)return null;
 const original=naturalSearchAliases(rawOriginal);
 if(areaDataQuery(original)) return await areaSearchMenu(original,u);
 let ctx=await getSearchContext(u); const range=dateRangeFromText(original);
 if(/^(select date( range)?|date range|search_date|SEARCH_DATE)$/i.test(original))return {dateMenu:true,text:'Select a time frame'};
 if(/^(CUSTOM_DATE_RANGE|custom range|custom date range)$/i.test(original))return {text:'Enter From date and To date.\nExample: 01/05/2026 to 31/05/2026\n\nCurrent equipment/module will be retained.'};
 // Date-menu selections and typed date ranges refine the active search; they are never treated as new equipment searches.
 if(range && ctx?.last_query && isDateOnlyCommand(original)){
   await setSearchFilters(u,{dateFrom:range.from,dateTo:range.to,offset:0});
   // Keep the selected range attached to the recursive search. Calling last_query alone
   // looked like a fresh equipment search and cleared the dates.
   return universalSearch(`${ctx.last_query} ${range.from} to ${range.to}`,u);
 }
 if(range && ctx) {await setSearchFilters(u,{dateFrom:range.from,dateTo:range.to,offset:0});ctx=await getSearchContext(u);}
 if(/^(analysis|analysis & maintenance|search_analysis)$/i.test(original) && ctx?.equipment_name){const perms=await searchPermissions(u);if(!perms.analysis)return {text:'Analysis is not available for your access level.'};return {analysisMenu:true,text:`${ctx.equipment_name} — Analysis & Maintenance`};}
 if(/^search by equipment$/i.test(original)){const a=ctx?.area||'';const rows=(await pool.query(`SELECT DISTINCT equipment AS name FROM lmmm_master_records WHERE equipment IS NOT NULL AND ($1::text='' OR LOWER(COALESCE(area,'')) LIKE LOWER('%'||$1||'%')) ORDER BY name LIMIT 10`,[a])).rows;return {text:rows.length?`Select/search equipment:\n${rows.map((x,i)=>`${i+1}. ${x.name}`).join('\n')}\n\nYou can also type the equipment name.`:'Type the equipment name to search.'};}
 if((wantsMore(original)||/^SEARCH_MORE$/i.test(original)) && ctx?.last_query){
   const next=(Number(ctx.page_offset)||0)+20;
   const dr=ctx.date_from?{from:String(ctx.date_from).slice(0,10),to:String(ctx.date_to||ctx.date_from).slice(0,10)}:null;
   const moreScope=await effectiveSearchScope(u); const allMore=await searchBundledMaster(ctx.last_query,100,dr,next); let rows=allMore.filter(r=>areaMatchesScope(r.area,moreScope,r.equipment)).slice(0,20);
   if(allMore.length && !rows.length && moreScope && !moreScope.plantWide)return {text:'Additional matching records are outside your authorised work scope.',status:'OUT_OF_SCOPE',buttons:await primarySearchButtons(u,false)};
   if(rows.length){await setSearchFilters(u,{offset:next}); return {text:`${ctx.equipment_name||'LMMM'}${dr?` | ${dr.from} to ${dr.to}`:''}\nShowing ${next+1}-${next+rows.length}\n\n${formatBundledResults(rows)}`,buttons:await primarySearchButtons(u,rows.length===20),status:'OK'};}
   return {text:'No more matching records in the current filters.',buttons:await primarySearchButtons(u,false)};
 }
 if(/^\d+$/.test(original)){
   const pr=(await pool.query(`SELECT * FROM pending_search_choices WHERE employee_number=$1 AND created_at>now()-interval '30 minutes'`,[u.employee_number])).rows[0];
   if(pr){const choices=typeof pr.choices==='string'?JSON.parse(pr.choices):pr.choices;const pick=choices[Number(original)-1];if(pick){await setSearchContext(u,pick.name,pick.area||null);await pool.query(`DELETE FROM pending_search_choices WHERE employee_number=$1`,[u.employee_number]);return universalSearch(pr.original_query,u);}}
 }
 ctx=await getSearchContext(u); let entity=stripIntentWords(naturalSearchAliases(original)); const alias=await resolveAlias(entity); if(alias)entity=alias.equipment_name||alias.canonical_text;
 if(!entity && ctx?.equipment_name)entity=ctx.equipment_name;
 const intent=searchIntent(original);
 // A clearly new asset search must not inherit an old date filter accidentally. Date-only follow-ups keep context above.
 if(!range && entity && !/^(more|next|search_more|analysis|search_analysis)$/i.test(original)){
   await clearSearchDates(u); ctx=await getSearchContext(u);
 }
 // Drawing numbers/part drawings and job procedures are reference-knowledge requests, not event/equipment searches.
 // Route them before fuzzy equipment discovery so a drawing number can never be mistaken for a defect/history term.
 if(intent==='drawing' || intent==='procedure'){
   const contextual=(ctx?.equipment_name && !/\b(wbf[- ]?[12]|furnace[- ]?[12])\b/i.test(original))?`${ctx.equipment_name} ${original}`:original;
   return {knowledgeQuery:contextual,referenceIntent:intent};
 }
 let candidates=entity?await equipmentCandidates(entity,ctx):[];
 const searchScope=await effectiveSearchScope(u);
 const unscopedCandidates=[...candidates];
 candidates=candidates.filter(x=>areaMatchesScope(x.area,searchScope,x.name));
 if(unscopedCandidates.length && !candidates.length && searchScope && !searchScope.plantWide){
   console.log('[SCOPE] OUT_OF_SCOPE candidate',{employee:u.employee_number,areas:searchScope?.areas,entity,candidates:unscopedCandidates.map(x=>({name:x.name,area:x.area}))});
   return {text:'This equipment/area is outside your authorised work scope.',status:'OUT_OF_SCOPE'};
 }
 // Exact canonical equipment/known alias always outranks fuzzy contains matches.
 const canonicalEntity=naturalSearchAliases(entity||'').trim().toLowerCase();
 const exact=candidates.filter(x=>String(x.name||'').trim().toLowerCase()===canonicalEntity);
 if(exact.length===1)candidates=exact;
 // A family query such as "Furnace defects" must offer only the actual furnace assets,
 // never every part whose description happens to contain the word furnace.
 if(/^furnaces?$/i.test(String(entity||'').trim())){
   const fam=(await pool.query(`SELECT DISTINCT equipment AS name,area FROM lmmm_master_records WHERE LOWER(equipment) IN ('wbf-1','wbf-2') ORDER BY name`)).rows;
   if(fam.length){candidates=fam.filter(x=>areaMatchesScope(x.area,searchScope,x.name));}
 }
 if(candidates.length>1 && (GENERIC_ASSET_WORDS.test(entity)||/^furnaces?$/i.test(String(entity||'').trim())||candidates.every(x=>String(x.name).toLowerCase()!==String(entity).toLowerCase()))){
   await pool.query(`INSERT INTO pending_search_choices(employee_number,original_query,choices,created_at) VALUES($1,$2,$3,now()) ON CONFLICT(employee_number) DO UPDATE SET original_query=EXCLUDED.original_query,choices=EXCLUDED.choices,created_at=now()`,[u.employee_number,original,JSON.stringify(candidates)]);
   const buttons=candidates.length<=3?candidates.map((x,i)=>({id:String(i+1),title:String(x.name).slice(0,20)})):null;
   return {text:`Multiple matches found. Which one?\n\n`+candidates.map((x,i)=>`${i+1}. ${x.name}${x.area?` — ${x.area}`:''}`).join('\n'),...(buttons?{buttons}:{})};
 }
 const equipment=candidates.length===1?candidates[0].name:(ctx?.equipment_name && !entity?ctx.equipment_name:null); if(equipment){await setSearchContext(u,equipment,candidates[0]?.area||ctx?.area||null);await setSearchFilters(u,{module:intent,offset:0,lastQuery:original});}
 ctx=await getSearchContext(u); const dr=range|| (ctx?.date_from?{from:String(ctx.date_from).slice(0,10),to:String(ctx.date_to||ctx.date_from).slice(0,10)}:null);
 // Totals/trends need a time frame; do not silently calculate lifetime analytics.
 if(['production','delay','analysis','maintenance','condition'].includes(intent) && !dr && /\b(total|cumulative|mtbf|mtbr|mttr|performance|trend|schedule|scheduled|production|delay|delays)\b/i.test(original)) return {text:'Select a time frame first.\nToday | Last 7 days | Last 30 days | This month | Custom date range'};
 const limit=wantsOverall(original)?30:20;
 const liveEvents=(await eventSearch(original,u,equipment,dr)).filter(x=>usefulLiveEvent(x,original));
 const unscopedMasterRows=await searchBundledMaster(original,Math.max(limit,200),dr,0);
 let masterRows=unscopedMasterRows.filter(r=>areaMatchesScope(r.area,searchScope,r.equipment)).slice(0,limit); const perms=await searchPermissions(u);
 if(unscopedMasterRows.length && !masterRows.length && searchScope && !searchScope.plantWide){
   console.log('[SCOPE] OUT_OF_SCOPE records',{employee:u.employee_number,areas:searchScope?.areas,equipment,query:original,sample:unscopedMasterRows.slice(0,5).map(r=>({equipment:r.equipment,area:r.area}))});
   return {text:'Matching LMMM records exist, but they are outside your authorised work scope.',status:'OUT_OF_SCOPE'};
 }
 if(masterRows.length){if(!equipment){const names=[...new Set(masterRows.map(r=>r.equipment).filter(Boolean))];if(names.length===1){await setSearchContext(u,names[0],masterRows[0]?.area||ctx?.area||null);await setSearchFilters(u,{module:intent,offset:0,lastQuery:original});}} let text=`${equipment||masterRows[0]?.equipment||'LMMM'}${dr?` | ${dr.from} to ${dr.to}`:''}\n${dr?`Showing ${masterRows.length} record${masterRows.length===1?'':'s'} in selected date range`:`Showing latest ${masterRows.length}${wantsOverall(original)?' (overall view max 30)':''}`}\n\n${formatBundledResults(masterRows)}`;if(liveEvents.length)text+=`\n\nRecent live entries\n${formatLiveEvents(liveEvents)}`;return {text,buttons:await primarySearchButtons(u,masterRows.length===limit),status:'OK'};}
 if(liveEvents.length)return {text:(equipment?`${equipment}${dr?` | ${dr.from} to ${dr.to}`:''}\n\n`:'')+formatLiveEvents(liveEvents),buttons:await primarySearchButtons(u,false),status:'OK'};
 // A selected date range is a hard filter. Never fall back to lifetime/latest records or
 // undated reference knowledge when the user asked for a specific period.
 if(dr && (equipment || ctx?.equipment_name)){
   const eq=equipment||ctx?.equipment_name||'Selected equipment';
   const mod=(ctx?.module||intent||'records').replace(/_/g,' ');
   return {text:`No ${eq} ${mod} records found from ${dr.from} to ${dr.to}.`,buttons:await primarySearchButtons(u,false),status:'NO_DATA_IN_RANGE'};
 }
 return {knowledgeQuery:equipment && !original.toLowerCase().includes(equipment.toLowerCase())?`${equipment} ${original}`:original,status:'NO_STRUCTURED_DATA'};
}

async function retrieveReferenceKnowledge(question,u){
 const ctx=await currentShiftContext(u);
 let terms=queryTokens(question);
 try{
  const q=await geminiGenerate([{text:`KNOWLEDGE SEARCH TERM EXPANSION ONLY. For this LMMM maintenance question, return reference_items where each text is one short English technical search term or phrase likely to appear in manuals/SOP/SMP/drawings/spares. Include equipment/item identifiers exactly if present. Question: ${question}`}],u,ctx);
  const extra=(q.reference_items||[]).map(x=>String(x.text||'').trim()).filter(Boolean);
  terms=[...new Set([...terms,...extra])].slice(0,16);
 }catch(_e){}
 if(!terms.length)return [];
 const clauses=terms.map((_,i)=>`(LOWER(coalesce(section_heading,'')) LIKE LOWER($${i+1}) OR LOWER(content_text) LIKE LOWER($${i+1}) OR LOWER(coalesce(equipment_name,'')) LIKE LOWER($${i+1}) OR LOWER(coalesce(title,'')) LIKE LOWER($${i+1}))`).join(' OR ');
 const vals=terms.map(x=>`%${x}%`);
 const r=await pool.query(`SELECT id,document_class,title,equipment_name,page_start,page_end,section_heading,content_text,source_filename FROM technical_document_chunks WHERE ${clauses} ORDER BY page_start NULLS LAST,id LIMIT 18`,vals);
 if(r.rows.length>=12)return r.rows;
 // Also search the clean unified source-backed knowledge layer (drawings, SMP/SOP, parts and legacy technical data).
 const kClauses=terms.map((_,i)=>`(LOWER(normalized_text) LIKE LOWER($${i+1}) OR LOWER(raw_text) LIKE LOWER($${i+1}) OR EXISTS (SELECT 1 FROM unnest(identifiers) z WHERE LOWER(z) LIKE LOWER($${i+1})))`).join(' OR ');
 const kr=await pool.query(`SELECT NULL::bigint AS id,'knowledge'::text AS document_class,source_name AS title,NULL::text AS equipment_name,NULL::int AS page_start,NULL::int AS page_end,NULL::text AS section_heading,raw_text AS content_text,source_name AS source_filename FROM lmmm_knowledge_records WHERE ${kClauses} LIMIT 18`,vals);
 const seen=new Set(r.rows.map(x=>String(x.source_filename||'')+'|'+String(x.page_start||'')+'|'+String(x.content_text||'').slice(0,120)));
 return [...r.rows,...kr.rows.filter(x=>{const k=String(x.source_filename||'')+'||'+String(x.content_text||'').slice(0,120);if(seen.has(k))return false;seen.add(k);return true;})].slice(0,18);
}
async function geminiAnswerFromKnowledge(question,rows,u){
 const lang=languageOf(question), ctx=await currentShiftContext(u);
 const source=rows.map((r,i)=>`[${i+1}] ${r.title||r.source_filename} | page ${r.page_start}${r.page_end&&r.page_end!==r.page_start?'-'+r.page_end:''} | ${r.section_heading||''}\n${r.content_text}`).join('\n\n');
 const prompt=`You are the LMMM maintenance knowledge assistant. Answer ONLY from the supplied indexed source excerpts. Do not invent missing values or procedures. If the answer is incomplete, say which part is not available in the indexed source. Reply in ${lang==='te'?'Telugu (Telugu script; keep necessary technical terms/identifiers in English)':lang==='hi'?'Hindi':'English'} because that is the user's language. Keep exact equipment/item/SAP/CAT/drawing/part identifiers unchanged. Be maintenance-friendly and concise. IMPORTANT: bracket labels such as [1], [2], [3] are excerpt IDs, NOT page numbers. Do NOT output bracket citation numbers and do NOT write a Source/Source page line; the application will append verified PDF page metadata. User question: ${question}\n\nSOURCE EXCERPTS:\n${source}`;
 const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
 const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:0.1}})});
 if(!r.ok)throw new Error(`Gemini answer ${r.status}: ${await r.text()}`);
 const j=await r.json();
 let answer=(j.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();
 // V5.7.1: source pages come only from DB metadata, never from model citation labels.
 answer=answer.replace(/\n?\s*(?:Source(?: page(?: number)?s?)?|మూలం|स्रोत)\s*[:：].*$/gim,'').trim();
 const pageKeys=[];
 for(const row of rows){
   const a=Number(row.page_start), b=Number(row.page_end||row.page_start);
   if(Number.isFinite(a)&&a>0){ const key=(Number.isFinite(b)&&b>a)?`${a}-${b}`:`${a}`; if(!pageKeys.includes(key))pageKeys.push(key); }
 }
 if(pageKeys.length){
   const label=lang==='te'?'మూల పేజీ':lang==='hi'?'स्रोत पृष्ठ':'Source page';
   answer += `\n\n${label}: ${pageKeys.join(', ')}`;
 }
 return answer;
}

async function repairTableDates(buf,mime,u,ctx,obj){
 const entries=Array.isArray(obj?.entries)?obj.entries:[];
 if(!entries.length || !obj?.table_has_date_column || !entries.some(e=>!e?.event_date))return obj;
 try{
  // Dedicated row/date reconstruction: the model only has to recover row identity + date,
  // then we merge dates back into the first-pass extraction instead of replacing good text.
  const datePass=await geminiGenerate([
   {text:`ROW/DATE RECONSTRUCTION PASS. Re-read the source table at maximum care. Previous extracted entries are below in row order. Return the normal JSON structure, but preserve the SAME number/order of entries. For each entry, use its text/equipment to locate the SAME source row and read ONLY that row's Date cell. Populate event_date exactly as printed. Never use today's date, never copy a neighbouring row date, never infer a year, and never invent an unreadable date. Keep the previous equipment/text unchanged where possible. Previous entries:\n${JSON.stringify(entries)}`},
   {inline_data:{mime_type:mime||'image/jpeg',data:buf.toString('base64')}}
  ],u,ctx);
  const recovered=Array.isArray(datePass?.entries)?datePass.entries:[];
  const merged=entries.map((e,i)=>{
    if(e?.event_date)return e;
    const r=recovered[i];
    return r?.event_date?{...e,event_date:r.event_date}:e;
  });
  const missing=merged.some(e=>!e?.event_date);
  return {...obj,entries:merged,uncertain:missing?Boolean(obj.uncertain):false,needs_event_time:false};
 }catch(e){console.error('[MEDIA DATE REPAIR]',e);return obj;}
}
function isCompleteMediaEntry(e){
 if(!e)return false;
 const supportedTypes=new Set(['production','delay','inspection','defect','job_action','logbook_note','vibration_reading','motor_load_reading']);
 if(!supportedTypes.has(e.type) || !e.event_date)return false;
 if(e.type==='production')return Number.isInteger(e.blooms_rolled) && e.blooms_rolled>=0;
 if(e.type==='delay')return Number.isInteger(e.delay_minutes) && e.delay_minutes>=0 && !!String(e.delay_section||'').trim() && !!String(e.reason||e.text||'').trim();
 return !!String(e.text||'').trim();
}

function mediaBatchCode(id){return `UP-${id}`;}
function mediaSummary(saved,mediaId,reviewCount=0){
 const counts={}; for(const x of saved||[]){const k=x.equipment||'Unresolved';counts[k]=(counts[k]||0)+1;}
 const byEq=Object.entries(counts).slice(0,8).map(([k,v])=>`${k}: ${v}`).join(' | ');
 return `✅ ${(saved||[]).length} records saved${byEq?`\n${byEq}`:''}${reviewCount?`\n⚠️ ${reviewCount} records need review`:''}\nBatch ID: ${mediaBatchCode(mediaId)}\nUse: UNDO ${mediaBatchCode(mediaId)} / VIEW ${mediaBatchCode(mediaId)}`;
}
async function extractOfficeOrAccess(buf,mime,name,u,ctx){
 const lower=String(name||'').toLowerCase();
 try{
  if(/\.xlsx?$/.test(lower)||/spreadsheet|ms-excel/i.test(mime)){
   const XLSX=await import('xlsx'); const wb=XLSX.read(buf,{type:'buffer',cellDates:true}); let out=[];
   for(const sh of wb.SheetNames){const rows=XLSX.utils.sheet_to_json(wb.Sheets[sh],{header:1,defval:null,raw:false});out.push(`SHEET: ${sh}\n`+rows.map(r=>r.map(v=>v??'').join(' | ')).join('\n'));}
   return {text:out.join('\n\n').slice(0,1000000),kind:'spreadsheet'};
  }
  if(/\.docx$/.test(lower)||/wordprocessingml/i.test(mime)){
   const mammoth=await import('mammoth'); const r=await mammoth.extractRawText({buffer:buf});return {text:String(r.value||'').slice(0,1000000),kind:'word'};
  }
  if(/\.(mdb|accdb)$/.test(lower)||/msaccess|access/i.test(mime)){
   const mod=await import('mdb-reader'); const MDBReader=mod.default||mod.MDBReader||mod; const db=new MDBReader(buf); const names=db.getTableNames(); let out=[];
   for(const tableName of names){try{const table=db.getTable(tableName);const rows=table.getData();out.push(`ACCESS TABLE: ${tableName}\n`+JSON.stringify(rows));}catch(e){out.push(`ACCESS TABLE: ${tableName}\n[READ ERROR: ${e.message}]`);}}
   return {text:out.join('\n\n').slice(0,1500000),kind:'access',tables:names};
  }
 }catch(e){const err=new Error(`STRUCTURED_READER_UNAVAILABLE: ${e.message}`);err.code='STRUCTURED_READER_UNAVAILABLE';throw err;}
 return null;
}
async function stageMedia(u,from,msg){
 const n=msg.image||msg.audio||msg.voice||msg.document;
 const type=msg.image?'image':(msg.audio||msg.voice)?'audio':'document';
 const meta=await mediaMeta(n.id), mime=meta.mime_type||n.mime_type||'', name=n.filename||`${type}-${n.id}`;
 const uploadSession=beginUploadSession(u.employee_number,n.id,name);
 const isTiff=/tiff?/i.test(mime)||/\.tiff?$/i.test(name);
 const isAccess=/access/i.test(mime)||/\.(mdb|accdb)$/i.test(name);
 // Bind conversion commands to the newest upload immediately, before expensive AI/indexing work.
 if(isTiff) rememberLatestConvertible(u.employee_number,n.id,{mime,name,kind:'tiff'});
 else if(isAccess) rememberLatestConvertible(u.employee_number,n.id,{mime,name,kind:'access'});
 const buf=await mediaBytes(meta.url),ctx=await currentShiftContext(u);
 cacheSource(u.employee_number,n.id,{buf,mime,name,mediaId:n.id,receivedAt:Date.now()});
 if(isTiff) rememberLatestConvertible(u.employee_number,n.id,{mime,name,kind:'tiff'});
 else if(isAccess) rememberLatestConvertible(u.employee_number,n.id,{mime,name,kind:'access'});
 let raw='',obj,geminiFile=null,sourcePart=null;
 const isPdf=/pdf/i.test(mime)||/\.pdf$/i.test(name);
 const isVisualImage=type==='image'||/image\/(?:jpeg|jpg|png|webp|heic|heif)/i.test(mime)||/\.(?:jpe?g|png|webp|heic|heif)$/i.test(name);
 const isLargeDocument=type==='document' && (buf.length>8*1024*1024 || isTiff);
 // Multi-page TIFF must use the file pipeline (not the single-photo path) so all frames/pages remain available.
 if(isLargeDocument){ await sendText(from,`📚 ${isTiff?'Multi-page TIFF / large visual document':'Large document'} received: ${name}\nProcessing the complete file in page batches. Please wait for the final page/index count.`); geminiFile=await geminiUploadFile(buf,mime,name); sourcePart=geminiFilePart(geminiFile,mime); }
 if(type==='audio'){obj=await extractAudio(buf,mime,u,ctx);raw=obj.summary||'';}
 else if(type==='image'){
   // WhatsApp photos are single-image sources. They still use the same classifier/schema so
   // reference material becomes searchable knowledge and event photos become structured records.
   obj=await extractPhoto(buf,mime,u,ctx);raw=obj.summary||'';
   if(!obj.page_count)obj.page_count=1;
 }
 else if(/text|csv|json|xml/i.test(mime)){raw=buf.toString('utf8').slice(0,150000);obj=await classifyExtracted(raw,u,ctx);}
 else if(/pdf/i.test(mime)){obj=await extractDocument(buf,mime,u,ctx,name,sourcePart);raw=obj.summary||'';}
 else if(/tiff/i.test(mime) || /\.tiff?$/i.test(name)){
   obj=await extractDocument(buf,mime,u,ctx,name,sourcePart);raw=obj.summary||'';
 }
 else if(/wordprocessingml|spreadsheetml|msword|ms-excel|msaccess|access/i.test(mime) || /\.(docx?|xlsx?|mdb|accdb)$/i.test(name)){
   try{const structured=await extractOfficeOrAccess(buf,mime,name,u,ctx);raw=structured?.text||'';obj=await classifyExtracted(`SOURCE FILE: ${name}\nSOURCE KIND: ${structured?.kind||'structured document'}\nExtract ALL relevant rows/records independently and preserve table/sheet names in text where useful.\n\n${raw}`,u,ctx);if(structured?.kind==='access')obj.source_tables=structured.tables||[];}
   catch(e){console.error('[STRUCTURED FILE READER]',e);obj={language:'en',uncertain:true,needs_event_time:false,document_class:'other_reference',document_kind:'document',title:name,summary:`Structured file received but its dedicated reader is unavailable: ${e.message}`,entries:[],reference_items:[],page_count:1};raw=obj.summary;}
 }
 else {obj={language:'en',uncertain:true,needs_event_time:false,document_kind:'document',table_has_date_column:false,summary:'File received. This file type is not parsed automatically yet.',entries:[]};}
 // Secondary deterministic safety net for obvious reference-document filenames.
 if(type==='document' && /(?:\bOMI\b|operation[ _-]*(?:and|&)[ _-]*maintenance|\bmanual\b|\bSOP\b|\bSMP\b)/i.test(name||'')){
   const hinted=/\bSOP\b/i.test(name)?'sop':/\bSMP\b/i.test(name)?'smp':'manual';
   obj={...obj,document_class:hinted,needs_event_time:false,entries:[]};
 }
 if((type==='image'||type==='document') && obj?.table_has_date_column && (obj.entries||[]).some(e=>!e?.event_date)) obj=await repairTableDates(buf,mime,u,ctx,obj);
 obj=normalizeMediaDates(obj).obj;
 const lang=obj.language||languageOf(raw);
 const entries=Array.isArray(obj.entries)?obj.entries:[];
 const referenceClasses=new Set(['manual','sop','smp','drawing','spares','other_reference']);
 const isReference=referenceClasses.has(obj.document_class);

 // Historical dated tables are row-independent. Save every complete row immediately and
 // hold ONLY incomplete rows for review. One bad date must never block or date-shift good rows.
 const isHistoricalTable=Boolean(obj.table_has_date_column);
 const validEntries=entries.filter(isCompleteMediaEntry);
 const reviewEntries=entries.filter(e=>!isCompleteMediaEntry(e));
 const wholeClear=!obj.uncertain && !obj.needs_event_time && reviewEntries.length===0 && validEntries.length>0;
 const status=(wholeClear || (isHistoricalTable&&validEntries.length))?'auto_processing':'pending_confirmation';
 const q=await pool.query(`INSERT INTO media_ingestion(employee_number,media_id,media_type,mime_type,filename,detected_language,extracted_text,extraction_json,status,entered_by)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
 [u.employee_number,n.id,type,mime,name,lang,raw,obj,status,from]);
 const mediaRowId=q.rows[0].id; await pool.query(`UPDATE media_ingestion SET batch_code=$2 WHERE id=$1`,[mediaRowId,mediaBatchCode(mediaRowId)]);

 if(isReference){
   // Reference photos, PDFs and multi-page TIFFs share one searchable knowledge store.
   const eq=(obj.equipment_refs||[])[0]||null;
   const kr=await pool.query(`INSERT INTO technical_document_knowledge(media_ingestion_id,employee_number,document_class,title,equipment_name,identifiers,content_json,source_filename,entered_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [mediaRowId,u.employee_number,obj.document_class,obj.title||name,eq,JSON.stringify(obj.identifiers||[]),obj,name,from]);
   let ix={total:Number(obj.page_count)||1,indexedPages:0,chunkCount:0};
   try{ix=await indexFullReferenceDocument(mediaRowId,kr.rows[0].id,buf,mime,u,from,obj,name,sourcePart);}
   catch(e){console.error('[REFERENCE INDEX]',e);ix={...ix,failedPages:ix.total||Number(obj.page_count)||1,failedRanges:[[1,ix.total||Number(obj.page_count)||1]]};}
   const refStatus=ix.failedPages?'reference_partial':'reference_indexed';
   await pool.query(`UPDATE media_ingestion SET status=$3,record_count=$2,review_count=$4 WHERE id=$1`,[mediaRowId,ix.chunkCount,refStatus,ix.failedPages||0]);
   await sendText(from,`${uploadCompletionPrefix(u.employee_number,uploadSession)}📘 ${String(obj.document_class).toUpperCase()} identified${obj.title?` — ${obj.title}`:''}
✅ ${ix.indexedPages}/${ix.total} ${isTiff?'TIFF page/frame(s)':'page(s)'} indexed
📚 ${ix.chunkCount} searchable knowledge sections indexed${ix.failedPages?`\n⚠️ ${ix.failedPages} ${isTiff?'TIFF page/frame(s)':'page(s)'} need review: ${ix.failedRanges.map(r=>r[0]===r[1]?r[0]:`${r[0]}-${r[1]}`).join(', ')}`:'\n✅ 0 failed pages'}
Batch ID: ${mediaBatchCode(mediaRowId)}

You can now ask questions from this source in English, Telugu or Hindi. Stored answers retain the verified source file and page/frame reference.`);
   return;
 }

 let saved=[];
 if(wholeClear){
   saved=await commitMedia(u,from,{media_ingestion_id:mediaRowId,proposed_json:{...obj,entries:validEntries}},'auto_confirmed','media_auto_confirmed');
   await sendText(from,uploadCompletionPrefix(u.employee_number,uploadSession)+mediaSummary(saved,mediaRowId,0)); return;
 }
 if(isHistoricalTable && validEntries.length){
   saved=await commitMedia(u,from,{media_ingestion_id:mediaRowId,proposed_json:{...obj,entries:validEntries}},reviewEntries.length?'partial_saved':'auto_confirmed','historical_row_auto_saved',false);
 }
 if(!reviewEntries.length){
   await sendText(from,uploadCompletionPrefix(u.employee_number,uploadSession)+mediaSummary(saved,mediaRowId,0)); return;
 }
 const pendingObj={...obj,entries:reviewEntries,uncertain:true,needs_event_time:false,partial_batch:true};
 await pool.query(`INSERT INTO pending_media_confirmations(employee_number,media_ingestion_id,proposed_json) VALUES($1,$2,$3)
 ON CONFLICT(employee_number) DO UPDATE SET media_ingestion_id=EXCLUDED.media_ingestion_id,proposed_json=EXCLUDED.proposed_json,created_at=now()`,[u.employee_number,mediaRowId,pendingObj]);
 const lines=reviewEntries.slice(0,15).map((e,i)=>`${i+1}. ${e.type}: ${e.equipment?e.equipment+' – ':''}${e.text||''}`).join('\n');
 if(isHistoricalTable){
   await sendText(from,`${uploadCompletionPrefix(u.employee_number,uploadSession)}${saved.length?mediaSummary(saved,mediaRowId,reviewEntries.length)+'\n\n':''}${lines}\n\n⚠️ Only these ${reviewEntries.length} row(s) are held for review because their own date/data is unreadable. Other dated rows were saved with their respective source dates. A common date/Today will NOT be applied to this historical batch.`);
 }else{
   const ask=obj.needs_event_time?ml(lang,'When did it happen?','ఇది ఎప్పుడు జరిగింది?','यह कब हुआ था?'):ml(lang,'Please confirm because some information is unclear: CONFIRM / CORRECT','కొంత సమాచారం స్పష్టంగా లేదు. దయచేసి CONFIRM / CORRECT చేయండి','कुछ जानकारी स्पष्ट नहीं है। कृपया CONFIRM / CORRECT करें');
   await sendText(from,`${uploadCompletionPrefix(u.employee_number,uploadSession)}${lines||obj.summary}\n\n${ask}`);
 }
}

async function commitMedia(u,from,p,status='confirmed',timingSource='media_confirmed',clearPending=true){
 const o=p.proposed_json,ctx=await currentShiftContext(u),n=plantNow(),saved=[];
 const mediaId=p.media_ingestion_id;
 const productionByKey=new Map();
 for(const e of (o.entries||[])){
  const d=e.event_date?(isoDate(e.event_date)||null):null,sh=e.event_shift||ctx.shift;
  if(!d)throw new Error(`Invalid media event_date: ${e.event_date}`);
  if(e.type==='production' && Number.isInteger(e.blooms_rolled)){
   const q=await pool.query(`INSERT INTO production_shift_logs(production_date,shift,area,blooms_rolled,operations_shift_incharge,remarks,entered_by,source_media_ingestion_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[d,sh||'Not found',u.area_of_working,e.blooms_rolled,u.name,`Media: ${e.text||''}`,from,mediaId]);
   productionByKey.set(`${d}|${sh||'Not found'}|${String(u.area_of_working).toLowerCase()}`,q.rows[0].id);
   saved.push({type:'production',id:q.rows[0].id,text:`${e.blooms_rolled} blooms`,equipment:e.equipment||null});
  }else if(['inspection','defect','job_action','logbook_note','vibration_reading','motor_load_reading'].includes(e.type)){
   const id=await saveSectionEvent(u,from,e.type,e.text||'',d,sh,timingSource,e.equipment||null,mediaId);
   saved.push({type:e.type,id,text:e.text||'',equipment:e.equipment||null});
  }else if(e.type==='delay' && Number.isInteger(e.delay_minutes)){
   const key=`${d}|${sh||'Not found'}|${String(u.area_of_working).toLowerCase()}`;
   let productionLogId=productionByKey.get(key);
   if(!productionLogId){
    const rows=(await pool.query(`SELECT id FROM production_shift_logs WHERE production_date=$1 AND shift=$2 AND LOWER(area)=LOWER($3) ORDER BY id DESC LIMIT 2`,[d,sh||'Not found',u.area_of_working])).rows;
    if(rows.length===1)productionLogId=rows[0].id;
   }
   if(productionLogId){
    const reason=String(e.reason||e.text||'').trim();
    const q=await pool.query(`INSERT INTO production_delays(production_log_id,delay_section,delay_minutes,reason,job_action,entered_by,source_media_ingestion_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[productionLogId,e.delay_section,e.delay_minutes,reason,null,from,mediaId]);
    saved.push({type:'delay',id:q.rows[0].id,text:`${e.delay_section}: ${e.delay_minutes} min - ${reason}`,equipment:e.equipment||null});
   }else{
    const id=await saveSectionEvent(u,from,'logbook_note',`Delay not linked to production log: ${e.delay_section} - ${e.delay_minutes} min - ${e.reason||e.text||''}`,d,sh,timingSource,e.equipment||null,mediaId);
    saved.push({type:'logbook_note',id,text:`Delay captured for review: ${e.delay_section} - ${e.delay_minutes} min`,equipment:e.equipment||null});
   }
  }
 }
 await pool.query(`UPDATE media_ingestion SET status=$2,record_count=$3 WHERE id=$1`,[p.media_ingestion_id,status,saved.length]);
 if(clearPending) await pool.query(`DELETE FROM pending_media_confirmations WHERE employee_number=$1`,[u.employee_number]);
 return saved;
}



// V7.7.30 AUTHORITATIVE ACCESS REPLACEMENT + SERVER-SIDE EXPORT GATE
// V7.7.29 AUTHORIZATION PRECEDENCE + REPORTS ACCESS
// Rule: authentication establishes identity; hierarchy establishes default scope/access; explicit Super Admin Access selection replaces defaults for capabilities.
// V7.7.24 PROJECT-WIDE MENU STANDARD
// Multi-select where multiple values are logically valid; single-select for exclusive values (e.g. operational role).
async function selectionGet(owner,key,target='',defaults=[]){
  const r=(await pool.query(`SELECT selected,context FROM ui_selection_sessions WHERE owner_key=$1 AND session_key=$2 AND target_key=$3`,[String(owner),key,String(target)])).rows[0];
  if(r)return {selected:Array.isArray(r.selected)?r.selected:[],context:r.context||{}};
  await pool.query(`INSERT INTO ui_selection_sessions(owner_key,session_key,target_key,selected) VALUES($1,$2,$3,$4::jsonb)
    ON CONFLICT(owner_key,session_key,target_key) DO NOTHING`,[String(owner),key,String(target),JSON.stringify(defaults)]);
  return {selected:[...defaults],context:{}};
}
async function selectionReset(owner,key,target='',values=[],context={}){
  await pool.query(`INSERT INTO ui_selection_sessions(owner_key,session_key,target_key,selected,context,updated_at)
    VALUES($1,$2,$3,$4::jsonb,$5::jsonb,now()) ON CONFLICT(owner_key,session_key,target_key)
    DO UPDATE SET selected=EXCLUDED.selected,context=EXCLUDED.context,updated_at=now()`,
    [String(owner),key,String(target),JSON.stringify(values),JSON.stringify(context)]);
}
async function selectionToggle(owner,key,target,value,defaults=[]){
  const st=await selectionGet(owner,key,target,defaults); const set=new Set(st.selected.map(String));
  if(set.has(String(value)))set.delete(String(value));else set.add(String(value));
  await selectionReset(owner,key,target,[...set],st.context); return [...set];
}
async function selectionClear(owner,key,target=''){await pool.query(`DELETE FROM ui_selection_sessions WHERE owner_key=$1 AND session_key=$2 AND target_key=$3`,[String(owner),key,String(target)]);}

const DATA_MENU_OPTIONS=[
 ['DEFECTS','Defects'],['JOBS','Jobs Done'],['HISTORY','History'],['PM','PM / Scheduled'],
 ['CBM','Inspection / CBM'],['BREAKDOWN','Breakdown / Delay'],['SPARES','Spares / Documents']
];
async function equipmentDataAvailability(ctx,u){
  const all=await allAnalysisRows(ctx,u,6000);
  const counts={
    DEFECTS:all.filter(r=>String(r.record_type).toLowerCase()==='defect').length,
    JOBS:all.filter(r=>String(r.record_type).toLowerCase()==='job_action'||isJobHistoryRow(r)).length,
    HISTORY:all.filter(r=>String(r.record_type).toLowerCase()==='history').length,
    PM:all.filter(isTruePmRow).length, CBM:all.filter(isTrueCbmRow).length,
    BREAKDOWN:all.filter(isDelayEvidenceRow).length,
    SPARES:all.filter(r=>/\b(spare|bearing|seal|coupling|blade|part no|item no|drawing)\b/i.test(String(r.record_text||''))).length
  };
  return {all,counts};
}
async function sendEquipmentDataMenu(to,u){
  const ctx=await getSearchContext(u); if(!ctx?.equipment_name){await sendText(to,'Select/search an equipment first.');return;}
  const perms=await searchPermissions(u), av=await equipmentDataAvailability(ctx,u);
  const allowed=(code)=> code==='DEFECTS'||code==='HISTORY' ? perms.view :
    code==='JOBS'?perms.jobs:code==='PM'?perms.pm:code==='CBM'?perms.cbm:code==='BREAKDOWN'?perms.delay:perms.view;
  const opts=DATA_MENU_OPTIONS.filter(([c])=>allowed(c)&&av.counts[c]>0);
  if(!opts.length){await sendText(to,`${ctx.equipment_name}\nNo authorised indexed data categories are available for selection.`);return;}
  let st=await selectionGet(u.employee_number,'EQUIPMENT_DATA',ctx.equipment_name,[]);
  const valid=new Set(opts.map(x=>x[0])); const selected=st.selected.filter(x=>valid.has(x));
  if(selected.length!==st.selected.length)await selectionReset(u.employee_number,'EQUIPMENT_DATA',ctx.equipment_name,selected,{});
  const rows=opts.map(([c,t])=>({id:`DATA_TOGGLE:${c}`,title:`${selected.includes(c)?'✓':'○'} ${t}`.slice(0,24),description:`${av.counts[c]} available record(s)`}));
  rows.push({id:'DATA_APPLY',title:'✓ Continue / Apply',description:`${selected.length} selected`});
  // Analysis is the single home for analytics and printable reports.
  if(perms.analysis)rows.push({id:'SEARCH_ANALYSIS',title:'Analysis',description:'Analysis + printable PDF'});
  rows.push({id:'SEARCH_DATE',title:'Date Range',description:'Apply one period to all selected data'});
  await sendList(to,`${ctx.equipment_name} • Select Data\nSelect one or more. Tap options to toggle, then Continue.`,`Select`,rows.slice(0,10),'Equipment Data');
}
function dataRowsForCode(all,code){
  if(code==='DEFECTS')return all.filter(r=>String(r.record_type).toLowerCase()==='defect');
  if(code==='JOBS')return all.filter(r=>String(r.record_type).toLowerCase()==='job_action'||isJobHistoryRow(r));
  if(code==='HISTORY')return all.filter(r=>String(r.record_type).toLowerCase()==='history');
  if(code==='PM')return all.filter(isTruePmRow);
  if(code==='CBM')return all.filter(isTrueCbmRow);
  if(code==='BREAKDOWN')return all.filter(isDelayEvidenceRow);
  if(code==='SPARES')return all.filter(r=>/\b(spare|bearing|seal|coupling|blade|part no|item no|drawing)\b/i.test(String(r.record_text||'')));
  return [];
}
async function applyEquipmentDataSelection(to,u){
  const ctx=await getSearchContext(u);if(!ctx?.equipment_name){await sendText(to,'Select/search an equipment first.');return;}
  const st=await selectionGet(u.employee_number,'EQUIPMENT_DATA',ctx.equipment_name,[]);
  if(!st.selected.length){await sendText(to,'Select at least one data option, then Continue.');return;}
  await selectionReset(u.employee_number,'EQUIPMENT_DATA',ctx.equipment_name,st.selected,{applied:true,applied_at:new Date().toISOString()});
  const {all}=await equipmentDataAvailability(ctx,u), dr=ctxRange(ctx), period=dr?` | ${dr.from} to ${dr.to}`:'';
  const sections=[]; let hidden=0;
  for(const code of st.selected){
    const title=(DATA_MENU_OPTIONS.find(x=>x[0]===code)||[code,code])[1], rows=dataRowsForCode(all,code);
    if(!rows.length)continue; const show=rows.slice(0,8); hidden+=Math.max(0,rows.length-show.length);
    sections.push(`${title} — ${rows.length}\n${formatBundledResults(show)}`);
  }
  const perms=await searchPermissions(u);
  const footer=`\n\nSelected: ${st.selected.join(', ')}${hidden?`\n${hidden} additional matching record(s) available.`:''}${perms.pdf?'\nPDF/Print access: up to 100 validated matching rows can be exported as a table.':''}`;
  await sendLongText(to,`${ctx.equipment_name} — Selected Maintenance Data${period}\n\n${sections.join('\n\n──────────\n\n')}${footer}`);
}

const ACCESS_PERMISSION_OPTIONS = [
 ['FULL_ACCESS','Full Access'],['VIEW','View Only'],['EDIT','View + Edit / Entry'],['REPORTS','Reports'],['PRINT_EXPORT','PDF / Print'],['ANALYSIS','Analysis'],['ADVANCED_REPORTS','Advanced Reports'],['RCM','RCM Analysis'],['DELETE_UNDO','Delete / Undo'],['APPROVAL','Approval'],['MASTER_EDIT','Master Edit'],['ACCESS_ADMIN','Access Admin']
];
const AUTHORITY_OPTIONS=[
 ['APPROVE_RECORDS','Approve Records'],['CORRECT_RECORDS','Correct Records'],['DELETE_RESTORE','Delete / Restore'],
 ['AUTHORISE_REPORTS','Authorise Reports'],['AUTHORISE_PRINTS','Authorise Prints'],['MANAGE_DOCUMENTS','Manage Documents'],
 ['MANAGE_EMPLOYEES','Manage Employees'],['GRANT_ACCESS','Grant Access'],['REVOKE_ACCESS','Revoke Access'],['MASTER_CHANGE_APPROVAL','Master Change Approval']
];
const ROLE_OPTIONS=[
 ['NORMAL_USER','Normal User'],['SHIFT_INCHARGE','Shift In-charge'],['AREA_INCHARGE','Area In-charge'],
 ['SECTION_INCHARGE','Section In-charge'],['HOD','HOD'],['DGM','DGM'],['SUPER_ADMIN','Super Admin']
];
const JOB_SCOPE_OPTIONS=[
 ['ALL','All maintenance'],['DEFECTS','Defects'],['JOBS','Jobs / Work Orders'],['PM','PM / Scheduled'],
 ['INSPECTION_CBM','Inspection / CBM'],['BREAKDOWN','Breakdown / Delay'],['HISTORY','History'],['SPARES_DOCS','Spares / Documents']
];
function isSuperAdminWA(wa=''){return SUPER_ADMIN_NUMBERS.has(String(wa).replace(/\D/g,''));}
async function requireSuperAdmin(to){if(!isSuperAdminWA(to)){await sendText(to,'Not authorized. Super Admin access required.');return false;}return true;}
async function findAdminEmployees(term){return employeeSearch(term);}
async function employeeGovernanceSummary(emp){
 const u=await byEmp(emp),a=await effectiveAuthority(emp); if(!u||!a)return null;
 const sc=await effectiveSearchScope(u);
 const perms=(a.special_permissions||[]).join(', ')||'None';
 const auth=(a.authority_grants||[]).join(', ')||'None';
 const roles=(a.responsibilities||[]).map(x=>x.responsibility_role).filter(Boolean).join(', ')||u.responsibility||'Normal Employee';
 const jobs=(sc.jobScopes||[]).join(', ')||'ALL';
 const inherited=(a.default_permissions||[]).map(x=>accessLabel(x.permission)).join(', ')||'None';
 return `Employee Control\n${u.name} / ${emp}\nDesignation: ${u.designation}\nDepartment/Section: ${u.section_department}\nRegistered Area: ${u.area_of_working}\nOperational Role: ${String(a.operational_role||'NORMAL_USER').replaceAll('_',' ')}\nResponsibility: ${roles}\n\nDefault / Inherited Access: ${inherited}\nDefault Source: Registration + approved hierarchy\nEffective Access Level: ${String(a.effective_access).replaceAll('_',' + ')}\nAuthority Scope: ${String(a.scope).replaceAll('_',' ')}\nEffective Area(s): ${sc.plantWide?'ALL':(sc.areas||[]).join(', ')||'Registered'}\nJob Scope: ${jobs}\nAccess Override: ${a.has_access_override?'YES — Super Admin selection':'NO — hierarchy defaults'}\nManual Override Access: ${perms}\nAuthority Grants: ${auth}`;
}
async function sendAccessAdminMenu(to,emp){
 if(!await requireSuperAdmin(to))return;
 const u=await byEmp(emp);if(!u||u.approval_status!=='approved'||!u.is_active){await sendText(to,'Employee not found or inactive.');return;}
 let summary;
 try { summary=await employeeGovernanceSummary(emp); }
 catch(e){
   console.error('[EMPLOYEE CONTROL SUMMARY]',emp,e);
   // Fail soft: admin must still be able to open controls while a legacy row is repaired.
   summary=`Employee Control\n${u.name||'Employee'} / ${emp}\nDesignation: ${u.designation||'Not assigned'}\nDepartment/Section: ${u.section_department||'Not assigned'}\nRegistered Area: ${u.area_of_working||'Not assigned'}\n\n⚠️ Some legacy access details are being synchronized. Management options remain available.`;
 }
 await sendList(to,summary,'Manage',[
  {id:`ACCESS_PERMS:${emp}`,title:'Access'}, {id:`ACCESS_ROLE:${emp}`,title:'Role'}, {id:`ACCESS_AUTH:${emp}`,title:'Authorities'},
  {id:`RESP_CHANGE:${emp}`,title:'Responsibilities'}, {id:`ACCESS_AREA:${emp}`,title:'Area / Equipment Scope'},
  {id:`ACCESS_JOB:${emp}`,title:'Job Responsibility'}, {id:`ACCESS_VIEW:${emp}`,title:'Effective Access'}, {id:`ACCESS_AUDIT:${emp}`,title:'Audit History'}
 ],'User Governance');
}
async function sendPermissionAdmin(to,emp,page=1){
 if(!await requireSuperAdmin(to))return; const a=await effectiveAuthority(emp);if(!a){await sendText(to,'Not found.');return;}
 const active=new Set(((a.has_access_override?a.override_permissions:a.special_permissions)||[]).map(x=>String(x).toUpperCase()));
 const inherited=new Set((a.default_permissions||[]).map(x=>String(x.permission||'').toUpperCase()));
 let st=await selectionGet(to,'ADMIN_ACCESS',emp,[...active]); const staged=new Set(st.selected);
 const start=page===2?8:0, chunk=ACCESS_PERMISSION_OPTIONS.slice(start,start+8);
 const rows=chunk.map(([code,title])=>({id:`ACCESS_STAGE:${code}:${emp}`,title:`${staged.has(code)?'✓':inherited.has(code)?'↳':'○'} ${title}`.slice(0,24),description:staged.has(code)?'Selected manual access':inherited.has(code)?'Default / inherited':'Available'}));
 if(page===1 && ACCESS_PERMISSION_OPTIONS.length>8)rows.push({id:`ACCESS_PERMS_PAGE2:${emp}`,title:'More Access Options',description:'Show remaining permissions'});
 else if(page===2)rows.push({id:`ACCESS_PERMS:${emp}`,title:'Back to first options'});
 rows.push({id:`ACCESS_APPLY:${emp}`,title:'✓ Apply Selection',description:`${staged.size} manual selection(s)`});
 await sendList(to,`Access • ${emp} • ${page===2?'More':'Main'}
↳ Default/Inherited • ✓ Manual override selection • ○ Available
Selecting View Only / View + Edit replaces old Full Access. Add Reports/PDF/Analysis only when required, then Apply.`,`Select`,rows,'Access');
}
async function togglePermissionAdmin(from,emp,permission){
 if(!await requireSuperAdmin(from))return;if(!ACCESS_PERMISSION_OPTIONS.some(x=>x[0]===permission)){await sendText(from,'Invalid permission.');return;}
 const u=await byEmp(emp);if(!u){await sendText(from,'Not found.');return;}
 const r=(await pool.query(`SELECT active FROM user_special_permissions WHERE employee_number=$1 AND permission=$2 LIMIT 1`,[emp,permission])).rows[0];
 const active=!(r?.active===true);
 await pool.query(`INSERT INTO user_special_permissions(employee_number,permission,active,granted_by,reason,updated_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(employee_number,permission) DO UPDATE SET active=EXCLUDED.active,granted_by=EXCLUDED.granted_by,granted_at=now(),reason=EXCLUDED.reason,updated_at=now()`,[emp,permission,active,from,'Super Admin WhatsApp control']);
 await pool.query(`INSERT INTO authority_audit(employee_number,action,performed_by,details) VALUES($1,$2,$3,$4::jsonb)`,[emp,active?'GRANT_PERMISSION':'REVOKE_PERMISSION',from,JSON.stringify({permission,reason:'Super Admin WhatsApp control'})]);
 await sendPermissionAdmin(from,emp);
}
async function sendRoleAdmin(to,emp){
 if(!await requireSuperAdmin(to))return;const u=await byEmp(emp);if(!u){await sendText(to,'Not found.');return;}
 const current=String(u.operational_role||'NORMAL_USER').toUpperCase();
 await sendList(to,`Operational Role • ${u.name} / ${emp}\nDesignation remains unchanged. Role controls operational authority baseline.`,`Select`,ROLE_OPTIONS.map(([c,t])=>({id:`ACCESS_ROLE_SET:${c}:${emp}`,title:`${current===c?'✓':'○'} ${t}`.slice(0,24)})),'Role');
}
async function setRoleAdmin(from,emp,role){
 if(!await requireSuperAdmin(from))return;if(!ROLE_OPTIONS.some(x=>x[0]===role)){await sendText(from,'Invalid role.');return;}
 const u=await byEmp(emp);if(!u){await sendText(from,'Not found.');return;}
 const old=u.operational_role||'NORMAL_USER';
 await pool.query(`UPDATE users SET operational_role=$2,updated_at=now() WHERE employee_number=$1`,[emp,role]);
 // Keep responsibility hierarchy synchronized without changing designation.
 const map={SHIFT_INCHARGE:'Shift In-charge',AREA_INCHARGE:'Area In-charge',SECTION_INCHARGE:'Section In-charge',HOD:'HOD',SUPER_ADMIN:'Super Admin'};
 if(map[role]){await pool.query(`UPDATE user_responsibilities SET active=false WHERE employee_number=$1 AND active=true`,[emp]);await pool.query(`INSERT INTO user_responsibilities(employee_number,responsibility_role,scope_section,scope_area,assigned_by) VALUES($1,$2,$3,$4,$5)`,[emp,map[role],u.section_department||NA,u.area_of_working||NA,from]);}
 await pool.query(`INSERT INTO authority_audit(employee_number,action,performed_by,details) VALUES($1,'SET_OPERATIONAL_ROLE',$2,$3::jsonb)`,[emp,from,JSON.stringify({old_role:old,new_role:role})]);
 await syncDefaultAccess(emp,from,'Operational role / hierarchy changed');
 await sendAccessAdminMenu(from,emp);
}
async function sendAuthorityAdmin(to,emp,page=1){
 if(!await requireSuperAdmin(to))return;const a=await effectiveAuthority(emp);if(!a){await sendText(to,'Not found.');return;}
 const active=new Set((a.authority_grants||[]).map(x=>String(x).toUpperCase()));
 let st=await selectionGet(to,'ADMIN_AUTH',emp,[...active]);const staged=new Set(st.selected);
 const start=page===2?8:0,chunk=AUTHORITY_OPTIONS.slice(start,start+8);
 const rows=chunk.map(([c,t])=>({id:`AUTH_STAGE:${c}:${emp}`,title:`${staged.has(c)?'✓':'○'} ${t}`.slice(0,24)}));
 if(page===1 && AUTHORITY_OPTIONS.length>8)rows.push({id:`ACCESS_AUTH_PAGE2:${emp}`,title:'More Authorities'});
 else if(page===2)rows.push({id:`ACCESS_AUTH:${emp}`,title:'Back to first options'});
 rows.push({id:`AUTH_APPLY:${emp}`,title:'✓ Apply Selection',description:`${staged.size} selected`});
 await sendList(to,`Authorities • ${emp} • ${page===2?'More':'Main'}
Select one or more, then Apply. Authority is separate from role and responsibility.`,`Select`,rows,'Authorities');
}
async function toggleAuthorityAdmin(from,emp,code){
 if(!await requireSuperAdmin(from))return;if(!AUTHORITY_OPTIONS.some(x=>x[0]===code)){await sendText(from,'Invalid authority.');return;}
 const r=(await pool.query(`SELECT active FROM user_authority_grants WHERE employee_number=$1 AND authority_code=$2 LIMIT 1`,[emp,code])).rows[0];const active=!(r?.active===true);
 await pool.query(`INSERT INTO user_authority_grants(employee_number,authority_code,active,reason,granted_by,updated_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(employee_number,authority_code) DO UPDATE SET active=EXCLUDED.active,reason=EXCLUDED.reason,granted_by=EXCLUDED.granted_by,updated_at=now()`,[emp,code,active,'Super Admin WhatsApp control',from]);
 await pool.query(`INSERT INTO authority_audit(employee_number,action,performed_by,details) VALUES($1,$2,$3,$4::jsonb)`,[emp,active?'GRANT_AUTHORITY':'REVOKE_AUTHORITY',from,JSON.stringify({authority:code})]);await sendAuthorityAdmin(from,emp);
}
async function departmentAreaOptions(){const r=await pool.query(`SELECT area,COUNT(*) n FROM lmmm_master_records WHERE NULLIF(TRIM(COALESCE(area,'')),'') IS NOT NULL GROUP BY area ORDER BY n DESC,area LIMIT 40`);return r.rows.map(x=>String(x.area).trim()).filter(Boolean);}
function areaDisplayLabel(a){
 const x=String(a||'').trim();
 if(/^BAR$/i.test(x)||/^bar mill$/i.test(x))return 'Bar Mill';
 if(/^FUR$/i.test(x)||/furnace/i.test(x))return 'Furnaces';
 if(/^BDM$/i.test(x))return 'BDM';
 if(/finish/i.test(x))return 'Finishing';
 if(/^(AUX|common|support)$/i.test(x))return 'Common / Support';
 return x;
}
async function sendAreaScopePicker(to,emp,page=1){
 if(!await requireSuperAdmin(to))return;const u=await byEmp(emp);if(!u){await sendText(to,'Not found.');return;}
 let areas=await departmentAreaOptions();if(u.area_of_working&&!areas.some(x=>x.toLowerCase()===String(u.area_of_working).toLowerCase()))areas.unshift(u.area_of_working);
 areas=[...new Set(areas)].slice(0,24);globalThis.__lmmmAreaPickers=globalThis.__lmmmAreaPickers||new Map();globalThis.__lmmmAreaPickers.set(String(emp),areas);
 const active=(await effectiveAuthority(emp))?.assignments?.map(x=>String(x.area||'')).filter(x=>x&&x!==NA)||[];
 let st=await selectionGet(to,'ADMIN_AREA',emp,active);const staged=new Set(st.selected);
 const start=(page-1)*7,chunk=areas.slice(start,start+7);
 const rows=chunk.map((a,i)=>({id:`AREA_STAGE:${start+i}:${emp}`,title:`${staged.has(a)?'✓':'○'} ${areaDisplayLabel(a)}`.slice(0,24),description:a===areaDisplayLabel(a)?undefined:`Source: ${a}`}));
 if(start+7<areas.length)rows.push({id:`ACCESS_AREA_PAGE:${page+1}:${emp}`,title:'More Areas'});
 if(page>1)rows.push({id:`ACCESS_AREA_PAGE:${page-1}:${emp}`,title:'Previous Areas'});
 rows.push({id:`AREA_APPLY:${emp}`,title:'✓ Apply Selection',description:`${staged.size} selected`});
 await sendList(to,`Area / Equipment Scope • ${emp}
Select one or more areas, then Apply. Equipment/sub-equipment/parts inherit the resulting scope.`,`Select`,rows.slice(0,10),'Area Scope');
}
async function stageAreaScope(from,emp,index){
 if(!await requireSuperAdmin(from))return;const areas=globalThis.__lmmmAreaPickers?.get(String(emp))||await departmentAreaOptions();const area=areas[Number(index)];
 if(!area){await sendText(from,'Area selection expired. Open Area / Equipment Scope again.');return;}
 await selectionToggle(from,'ADMIN_AREA',emp,area,[]);await sendAreaScopePicker(from,emp,Math.floor(Number(index)/7)+1);
}
async function applyAreaSelection(from,emp){
 if(!await requireSuperAdmin(from))return;const u=await byEmp(emp);if(!u){await sendText(from,'Not found.');return;}
 const st=await selectionGet(from,'ADMIN_AREA',emp,[]);const selected=st.selected.length?st.selected:[u.area_of_working].filter(Boolean);
 const latest=(await pool.query(`SELECT * FROM user_assignments WHERE employee_number=$1 AND active=true ORDER BY id DESC LIMIT 1`,[emp])).rows[0];
 const jobs=[...new Set((await pool.query(`SELECT job_scope FROM user_assignments WHERE employee_number=$1 AND active=true`,[emp])).rows.map(x=>x.job_scope||'ALL'))];
 await pool.query(`UPDATE user_assignments SET active=false WHERE employee_number=$1 AND active=true`,[emp]);
 for(const area of selected)for(const jobScope of (jobs.length?jobs:['ALL']))await pool.query(`INSERT INTO user_assignments(employee_number,area,section,responsibility,sub_area,shift,employment_type,is_additional_charge,job_scope,assigned_by,reason)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[emp,area,u.section_department||NA,latest?.responsibility||u.responsibility||NA,latest?.sub_area||NA,latest?.shift||NA,latest?.employment_type||NA,!!latest?.is_additional_charge,jobScope,from,'Super Admin multi-area scope']);
 await pool.query(`INSERT INTO authority_audit(employee_number,action,performed_by,details) VALUES($1,'APPLY_AREA_SCOPE_SET',$2,$3::jsonb)`,[emp,from,JSON.stringify({areas:selected})]);
 await syncDefaultAccess(emp,from,'Area / work scope changed');await selectionClear(from,'ADMIN_AREA',emp);await sendAccessAdminMenu(from,emp);
}
async function sendJobScopePicker(to,emp){if(!await requireSuperAdmin(to))return;const a=await effectiveAuthority(emp);if(!a){await sendText(to,'Not found.');return;}const current=new Set((a.assignments||[]).map(x=>String(x.job_scope||'ALL').toUpperCase()));let st=await selectionGet(to,'ADMIN_JOB',emp,[...current]);const staged=new Set(st.selected);
 const rows=JOB_SCOPE_OPTIONS.map(([c,t])=>({id:`JOB_STAGE:${c}:${emp}`,title:`${staged.has(c)?'✓':'○'} ${t}`.slice(0,24)}));
 rows.push({id:`JOB_APPLY:${emp}`,title:'✓ Apply Selection',description:`${staged.size} selected`});
 await sendList(to,`Job Responsibility • ${emp}\nSelect one or more work families, then Apply.`,`Select`,rows,'Job Scope');}
async function setJobScope(from,emp,jobScope){if(!await requireSuperAdmin(from))return;if(!JOB_SCOPE_OPTIONS.some(x=>x[0]===jobScope)){await sendText(from,'Invalid job scope.');return;}const u=await byEmp(emp);if(!u){await sendText(from,'Not found.');return;}const latest=(await pool.query(`SELECT * FROM user_assignments WHERE employee_number=$1 AND active=true ORDER BY id DESC LIMIT 1`,[emp])).rows[0];await pool.query(`UPDATE user_assignments SET active=false WHERE employee_number=$1 AND active=true`,[emp]);await pool.query(`INSERT INTO user_assignments(employee_number,area,section,responsibility,sub_area,shift,employment_type,is_additional_charge,job_scope,assigned_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[emp,latest?.area||u.area_of_working||NA,latest?.section||u.section_department||NA,latest?.responsibility||u.responsibility||NA,latest?.sub_area||NA,latest?.shift||NA,latest?.employment_type||NA,!!latest?.is_additional_charge,jobScope,from,'Super Admin job responsibility']);await pool.query(`INSERT INTO authority_audit(employee_number,action,performed_by,details) VALUES($1,'SET_JOB_SCOPE',$2,$3::jsonb)`,[emp,from,JSON.stringify({job_scope:jobScope})]);await sendAccessAdminMenu(from,emp);}

async function stageAdminOption(from,key,emp,code,sendFn){
 if(!await requireSuperAdmin(from))return;
 if(key==='ADMIN_ACCESS'){
   const st=await selectionGet(from,key,emp,[]); const set=new Set(st.selected.map(x=>String(x).toUpperCase()));
   const c=String(code).toUpperCase();
   // Access profiles are mutually exclusive. Selecting View or View+Edit must remove old Full Access immediately.
   if(c==='FULL_ACCESS'){ set.clear(); set.add('FULL_ACCESS'); }
   else if(c==='VIEW'){ set.clear(); set.add('VIEW'); }
   else if(c==='EDIT'){ set.clear(); set.add('EDIT'); set.add('ENTRY'); set.add('VIEW'); }
   else { if(set.has(c))set.delete(c); else set.add(c); }
   await selectionReset(from,key,emp,[...set],st.context);
 } else await selectionToggle(from,key,emp,code,[]);
 await sendFn(from,emp);
}
async function applyAccessSelection(from,emp){
 if(!await requireSuperAdmin(from))return;
 const st=await selectionGet(from,'ADMIN_ACCESS',emp,[]),sel=new Set(st.selected.map(x=>String(x).toUpperCase()));
 // Base profiles are exclusive. EDIT means View + Entry; it does NOT imply reports, PDF, analysis or RCM.
 if(sel.has('FULL_ACCESS')){ sel.clear(); sel.add('FULL_ACCESS'); }
 else if(sel.has('EDIT')){ sel.delete('FULL_ACCESS'); sel.add('ENTRY'); sel.add('VIEW'); }
 else if(sel.has('VIEW')){ sel.delete('FULL_ACCESS'); sel.delete('EDIT'); sel.delete('ENTRY'); }
 const persistedCodes=[...new Set([...ACCESS_PERMISSION_OPTIONS.map(x=>x[0]),'ENTRY'])];
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  // Authoritative replacement: first revoke EVERY persisted capability for this employee.
  // This is what makes Full -> View/Edit downgrades immediate and prevents stale PDF/Analysis rights.
  await client.query(`UPDATE user_special_permissions SET active=false,granted_by=$2,reason=$3,updated_at=now() WHERE employee_number=$1`,
    [emp,from,'Replaced by Super Admin access profile']);
  for(const code of persistedCodes){
   const active=sel.has(code);
   await client.query(`INSERT INTO user_special_permissions(employee_number,permission,active,granted_by,reason,updated_at)
    VALUES($1,$2,$3,$4,$5,now())
    ON CONFLICT(employee_number,permission) DO UPDATE SET active=EXCLUDED.active,granted_by=EXCLUDED.granted_by,granted_at=now(),reason=EXCLUDED.reason,updated_at=now()`,
    [emp,code,active,from,'Super Admin authoritative access profile']);
  }
  // Persist one authoritative snapshot. This is the decisive runtime access state.
  await client.query(`INSERT INTO user_access_override(employee_number,enabled,permissions,updated_by,updated_at,reason)
    VALUES($1,true,$2::jsonb,$3,now(),$4)
    ON CONFLICT(employee_number) DO UPDATE SET enabled=true,permissions=EXCLUDED.permissions,updated_by=EXCLUDED.updated_by,updated_at=now(),reason=EXCLUDED.reason`,
    [emp,JSON.stringify([...sel]),from,'Super Admin authoritative access profile']);
  await client.query(`INSERT INTO authority_audit(employee_number,action,performed_by,details) VALUES($1,'REPLACE_PERMISSION_SET',$2,$3::jsonb)`,
    [emp,from,JSON.stringify({permissions:[...sel],mode:'AUTHORITATIVE_OVERRIDE_V2'})]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 await selectionClear(from,'ADMIN_ACCESS',emp);
 // Re-read from PostgreSQL after commit; never trust staged/UI state as authorization state.
 const verified=await effectiveAuthority(emp); const active=new Set(((verified?.has_access_override?verified?.override_permissions:verified?.special_permissions)||[]).map(x=>String(x).toUpperCase()));
 console.log('[ACCESS APPLY VERIFIED]',emp,[...active].sort().join(','));
 await sendAccessAdminMenu(from,emp);
}
async function applyAuthoritySelection(from,emp){
 if(!await requireSuperAdmin(from))return;const st=await selectionGet(from,'ADMIN_AUTH',emp,[]),sel=new Set(st.selected);
 for(const [code] of AUTHORITY_OPTIONS){
  await pool.query(`INSERT INTO user_authority_grants(employee_number,authority_code,active,reason,granted_by,updated_at) VALUES($1,$2,$3,$4,$5,now())
   ON CONFLICT(employee_number,authority_code) DO UPDATE SET active=EXCLUDED.active,reason=EXCLUDED.reason,granted_by=EXCLUDED.granted_by,updated_at=now()`,
   [emp,code,sel.has(code),'Super Admin staged multi-select',from]);
 }
 await pool.query(`INSERT INTO authority_audit(employee_number,action,performed_by,details) VALUES($1,'APPLY_AUTHORITY_SET',$2,$3::jsonb)`,[emp,from,JSON.stringify({authorities:[...sel]})]);
 await selectionClear(from,'ADMIN_AUTH',emp);await sendAccessAdminMenu(from,emp);
}
async function applyJobSelection(from,emp){
 if(!await requireSuperAdmin(from))return;const u=await byEmp(emp);if(!u){await sendText(from,'Not found.');return;}
 const st=await selectionGet(from,'ADMIN_JOB',emp,[]);let selected=st.selected.filter(x=>JOB_SCOPE_OPTIONS.some(o=>o[0]===x));
 if(selected.includes('ALL'))selected=['ALL']; if(!selected.length)selected=['ALL'];
 const latest=(await pool.query(`SELECT * FROM user_assignments WHERE employee_number=$1 AND active=true ORDER BY id DESC LIMIT 1`,[emp])).rows[0];
 await pool.query(`UPDATE user_assignments SET active=false WHERE employee_number=$1 AND active=true`,[emp]);
 for(const jobScope of selected)await pool.query(`INSERT INTO user_assignments(employee_number,area,section,responsibility,sub_area,shift,employment_type,is_additional_charge,job_scope,assigned_by,reason)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[emp,latest?.area||u.area_of_working||NA,latest?.section||u.section_department||NA,latest?.responsibility||u.responsibility||NA,latest?.sub_area||NA,latest?.shift||NA,latest?.employment_type||NA,!!latest?.is_additional_charge,jobScope,from,'Super Admin staged multi-select']);
 await pool.query(`INSERT INTO authority_audit(employee_number,action,performed_by,details) VALUES($1,'APPLY_JOB_SCOPE_SET',$2,$3::jsonb)`,[emp,from,JSON.stringify({job_scopes:selected})]);
 await selectionClear(from,'ADMIN_JOB',emp);await sendAccessAdminMenu(from,emp);
}

async function sendEffectiveAccess(to,emp){if(!await requireSuperAdmin(to))return;const t=await employeeGovernanceSummary(emp);await sendText(to,t?`${t}\n\nServer-side enforcement is authoritative. Aliases/shortcuts never bypass scope.`:'Not found.');}
async function sendAccessAudit(to,emp){
 if(!await requireSuperAdmin(to))return;
 try{
  const r=await pool.query(`SELECT action,performed_by,created_at,details FROM authority_audit WHERE employee_number=$1 ORDER BY created_at DESC NULLS LAST,id DESC LIMIT 15`,[emp]);
  if(!r.rows.length){await sendText(to,`Audit History • ${emp}\nNo access changes recorded.`);return;}
  await sendText(to,`Audit History • ${emp}\n\n`+r.rows.map(x=>`${x.created_at?.toISOString?.()||x.created_at||'Time unavailable'} | ${x.action||'AUDIT'} | by ${x.performed_by||'Legacy/System'}\n${JSON.stringify(x.details||{})}`).join('\n\n').slice(0,3900));
 }catch(e){console.error('[ACCESS AUDIT READ]',e);await sendText(to,`Audit History • ${emp}\nAudit data is temporarily unavailable; employee access controls are still usable.`);}
}

async function ownerCommand(from, text) {
  const admin = from.replace(/\D/g, '');
  if (!SUPER_ADMIN_NUMBERS.has(admin)) return false;

  text = String(text || '').replace(/^APPROVE:(\d+)$/i, 'approve $1').replace(/^REJECT:(\d+)$/i, 'reject $1').replace(/^CONFIRM_REMOVE:(\d+)$/i, 'confirm remove $1').replace(/^CANCEL_REMOVE:(\d+)$/i, 'cancel remove $1').replace(/^CONFIRM_RESET$/i, 'confirm reset registrations').replace(/^CANCEL_RESET$/i, 'cancel reset registrations');

  let rx;
  if ((rx=text.match(/^(?:ACCESS|ACCESS CONTROL|USER|USER CONTROL)\s+(.+)$/i))) {
    const rows=await findAdminEmployees(rx[1]);
    if(!rows.length){await sendText(from,'Employee not found.');return true;}
    if(rows.length===1){await sendAccessAdminMenu(from,rows[0].employee_number);return true;}
    await sendList(from,'Select employee','Select',rows.map(x=>({id:`ACCESS:${x.employee_number}`,title:String(x.name).slice(0,24),description:`Emp No: ${x.employee_number}`})),'Employees');return true;
  }
  if ((rx=text.match(/^ACCESS:(\d+)$/i))) { await sendAccessAdminMenu(from,rx[1]); return true; }
  if ((rx=text.match(/^ACCESS_PERMS:(\d+)$/i))) { await sendPermissionAdmin(from,rx[1]); return true; }
  if ((rx=text.match(/^ACCESS_PERMS_PAGE2:(\d+)$/i))) { await sendPermissionAdmin(from,rx[1],2); return true; }
  if ((rx=text.match(/^ACCESS_ROLE:(\d+)$/i))) { await sendRoleAdmin(from,rx[1]); return true; }
  if ((rx=text.match(/^ACCESS_ROLE_SET:([A-Z_]+):(\d+)$/i))) { await setRoleAdmin(from,rx[2],rx[1].toUpperCase()); return true; }
  if ((rx=text.match(/^ACCESS_AUTH:(\d+)$/i))) { await sendAuthorityAdmin(from,rx[1]); return true; }
  if ((rx=text.match(/^ACCESS_AUTH_TOGGLE:([A-Z_]+):(\d+)$/i))) { await toggleAuthorityAdmin(from,rx[2],rx[1].toUpperCase()); return true; }
  if ((rx=text.match(/^ACCESS_AUTH_PAGE2:(\d+)$/i))) { await sendAuthorityAdmin(from,rx[1],2); return true; }
  if ((rx=text.match(/^ACCESS_AUDIT:(\d+)$/i))) { await sendAccessAudit(from,rx[1]); return true; }
  if ((rx=text.match(/^ACCESS_TOGGLE:([A-Z_]+):(\d+)$/i))) { await togglePermissionAdmin(from,rx[2],rx[1].toUpperCase()); return true; }
  if ((rx=text.match(/^ACCESS_AREA:(\d+)$/i))) { await sendAreaScopePicker(from,rx[1]); return true; }
  if ((rx=text.match(/^ACCESS_AREA_SET:([A-Z0-9_]+):(\d+)$/i))) { await sendAreaScopePicker(from,rx[2]); return true; }
  if ((rx=text.match(/^ACCESS_AREA_PAGE:(\d+):(\d+)$/i))) { await sendAreaScopePicker(from,rx[2],Number(rx[1])); return true; }
  if ((rx=text.match(/^AREA_STAGE:(\d+):(\d+)$/i))) { await stageAreaScope(from,rx[2],Number(rx[1])); return true; }
  if ((rx=text.match(/^AREA_APPLY:(\d+)$/i))) { await applyAreaSelection(from,rx[1]); return true; }
  if ((rx=text.match(/^ACCESS_JOB:(\d+)$/i))) { await sendJobScopePicker(from,rx[1]); return true; }
  if ((rx=text.match(/^ACCESS_JOB_SET:([A-Z_]+):(\d+)$/i))) { await setJobScope(from,rx[2],rx[1].toUpperCase()); return true; }
  if ((rx=text.match(/^ACCESS_VIEW:(\d+)$/i))) { await sendEffectiveAccess(from,rx[1]); return true; }

  if ((rx=text.match(/^ACCESS_STAGE:([A-Z_]+):(\d+)$/i))) { await stageAdminOption(from,'ADMIN_ACCESS',rx[2],rx[1].toUpperCase(),sendPermissionAdmin); return true; }
  if ((rx=text.match(/^ACCESS_APPLY:(\d+)$/i))) { await applyAccessSelection(from,rx[1]); return true; }
  if ((rx=text.match(/^AUTH_STAGE:([A-Z_]+):(\d+)$/i))) { await stageAdminOption(from,'ADMIN_AUTH',rx[2],rx[1].toUpperCase(),sendAuthorityAdmin); return true; }
  if ((rx=text.match(/^AUTH_APPLY:(\d+)$/i))) { await applyAuthoritySelection(from,rx[1]); return true; }
  if ((rx=text.match(/^JOB_STAGE:([A-Z_]+):(\d+)$/i))) { await stageAdminOption(from,'ADMIN_JOB',rx[2],rx[1].toUpperCase(),sendJobScopePicker); return true; }
  if ((rx=text.match(/^JOB_APPLY:(\d+)$/i))) { await applyJobSelection(from,rx[1]); return true; }

  if ((rx=text.match(/^SET RESPONSIBILITY\s+(\d+)$/i))) {
    const u=await byEmp(rx[1]);
    if(!u || u.approval_status!=='approved' || !u.is_active) await sendText(from,'Not found.');
    else await sendResponsibilityPicker(from,rx[1]);
    return true;
  }
  if ((rx=text.match(/^RESP_CHANGE:(\d+)$/i))) {
    await sendResponsibilityPicker(from,rx[1]); return true;
  }
  if ((rx=text.match(/^RESP:(HOD|SECTION_INCHARGE|AREA_INCHARGE|SHIFT_INCHARGE|GENERAL_SHIFT|NORMAL_EMPLOYEE):(\d+)$/i))) {
    await setResponsibility(from,rx[2],rx[1].toUpperCase()); return true;
  }
  if (/^RESP_DONE:\d+$/i.test(text)) {
    await sendText(from,'Done.'); return true;
  }

  let m = text.match(/^approve\s+(\d+)$/i);
  if (m) {
    const u = await byEmp(m[1]);
    if (!u) {
      await sendText(from, 'Not found.');
      return true;
    }

    await pool.query(
      `UPDATE users
       SET approval_status='approved', is_active=true,
           employee_category=$2, updated_at=now()
       WHERE employee_number=$1`,
      [m[1], employeeCategory(u.designation)]
    );

    await pool.query(
      `INSERT INTO user_assignments(
         employee_number,area,section,responsibility,assigned_by
       ) VALUES($1,$2,$3,$4,$5)`,
      [
        m[1],
        u.area_of_working || NA,
        u.section_department || NA,
        u.responsibility || NA,
        from
      ]
    );

    await syncDefaultAccess(m[1],from,'Registration approved: designation + section + registered area baseline');
    await sendText(u.whatsapp_number, 'Welcome to LMMM AI Maintenance.');
    if (from.replace(/\D/g, '') !== u.whatsapp_number.replace(/\D/g, '')) {
      await sendButtons(
        from,
        `Registration approved\n${u.name} / ${u.employee_number}`,
        [
          {id:`RESP_CHANGE:${u.employee_number}`,title:'Set Responsibility'},
          {id:`ACCESS_PERMS:${u.employee_number}`,title:'Access Options'},
          {id:`RESP_DONE:${u.employee_number}`,title:'Later'}
        ]
      );
    }
    return true;
  }

  m = text.match(/^reject\s+(\d+)$/i);
  if (m) {
    const u = await byEmp(m[1]);
    if (!u) {
      await sendText(from, 'Not found.');
      return true;
    }

    const wa = u.whatsapp_number;
    await deleteRegistrationByEmployee(m[1]);

    await sendText(wa, 'Registration rejected. You can register again.');
    if (from.replace(/\D/g, '') !== wa.replace(/\D/g, '')) {
      await sendText(from, `Rejected ${m[1]}.`);
    }
    return true;
  }

  m = text.match(/^assign\s+(\d+)\s+(.+)$/i);
  if (m) {
    const get = k =>
      ((m[2].match(new RegExp(k + '\\s*=\\s*([^;]+)', 'i')) || [])[1] || NA).trim();

    await pool.query(
      `INSERT INTO user_assignments(
         employee_number,area,section,responsibility,sub_area,shift,
         employment_type,is_additional_charge,assigned_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        m[1],
        get('AREA'),
        get('SECTION'),
        get('RESPONSIBILITY'),
        get('SUBAREA'),
        get('SHIFT'),
        get('EMPLOYMENT'),
        /ADDITIONAL\s*=\s*(YES|TRUE)/i.test(m[2]),
        from
      ]
    );

    await sendText(from, `Assignment updated for ${m[1]}.`);
    return true;
  }

  m = text.match(/^(grant|revoke)\s+(\d+)\s+(ENTRY|VIEW|EDIT|DELETE_UNDO|APPROVAL|PRINT_EXPORT|ANALYSIS|REPORTS|RCM|MASTER_EDIT|ACCESS_ADMIN|ADVANCED_REPORTS|FULL_ACCESS)$/i);
  if (m) {
    const active = m[1].toLowerCase() === 'grant';

    await pool.query(
      `INSERT INTO user_special_permissions(
         employee_number,permission,active,granted_by
       ) VALUES($1,$2,$3,$4)
       ON CONFLICT(employee_number,permission)
       DO UPDATE SET
         active=EXCLUDED.active,
         granted_by=EXCLUDED.granted_by,
         granted_at=now()`,
      [m[2], m[3].toUpperCase(), active, from]
    );

    await pool.query(`INSERT INTO authority_audit(employee_number,action,performed_by,details) VALUES($1,$2,$3,$4::jsonb)`,[m[2],active?'GRANT_PERMISSION':'REVOKE_PERMISSION',from,JSON.stringify({permission:m[3].toUpperCase(),source:'admin_text_command'})]);
    await sendText(
      from,
      `${m[3].toUpperCase()} ${active ? 'granted' : 'revoked'} for ${m[2]}.`
    );
    return true;
  }

  m = text.match(/^(disable|enable)\s+(\d+)$/i);
  if (m) {
    const exists = await byEmp(m[2]);
    if (!exists) {
      await sendText(from, 'Not found.');
      return true;
    }

    await pool.query(
      'UPDATE users SET is_active=$1,updated_at=now() WHERE employee_number=$2',
      [m[1].toLowerCase() === 'enable', m[2]]
    );

    await sendText(from, `${m[2]} ${m[1].toLowerCase()}d.`);
    return true;
  }

  m = text.match(/^remove\s+(\d+)$/i);
  if (m) {
    const exists = await byEmp(m[1]);
    if (!exists) {
      await sendText(from, 'Not found.');
      return true;
    }
    await sendButtons(from, `Remove ${m[1]}?`, [
      { id: `CONFIRM_REMOVE:${m[1]}`, title: 'Remove' },
      { id: `CANCEL_REMOVE:${m[1]}`, title: 'Cancel' }
    ]);
    return true;
  }

  m = text.match(/^cancel\s+remove\s+(\d+)$/i);
  if (m) { await sendText(from, 'Cancelled.'); return true; }

  m = text.match(/^confirm\s+remove\s+(\d+)$/i);
  if (m) {
    const removed = await deleteRegistrationByEmployee(m[1]);
    if (!removed) {
      await sendText(from, 'Not found.');
      return true;
    }

    await sendText(removed.whatsapp_number, 'Registration removed.');
    await sendText(from, `${m[1]} removed.`);
    return true;
  }

  if (/^reset registrations$/i.test(text.trim())) {
    await sendButtons(from, 'Remove all registrations?', [
      { id: 'CONFIRM_RESET', title: 'Confirm' },
      { id: 'CANCEL_RESET', title: 'Cancel' }
    ]);
    return true;
  }

  if (/^cancel reset registrations$/i.test(text.trim())) { await sendText(from, 'Cancelled.'); return true; }

  if (/^confirm reset registrations$/i.test(text.trim())) {
    await pool.query('BEGIN');
    try {
      await pool.query('DELETE FROM user_special_permissions');
      await pool.query('DELETE FROM user_responsibilities');
      await pool.query('DELETE FROM user_assignments');
      await pool.query('DELETE FROM users');
      await pool.query('COMMIT');
      await sendText(from, 'All registrations removed.');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }
    return true;
  }

  return false;
}

async function saveFreshRegistration(from, d) {
  const existingWA = await byWA(from);
  const existingEmp = await byEmp(d.employee_number);

  // Approved/active employee number must never be silently transferred to another WhatsApp number.
  if (
    existingEmp &&
    existingEmp.whatsapp_number !== from &&
    existingEmp.approval_status === 'approved' &&
    existingEmp.is_active === true
  ) {
    return { ok: false, reason: 'EMPLOYEE_ALREADY_ACTIVE' };
  }

  await pool.query('BEGIN');
  try {
    // Remove stale/rejected/removed/test records that would cause either unique-key conflict.
    if (existingWA && existingWA.employee_number !== d.employee_number) {
      await pool.query(
        'DELETE FROM user_special_permissions WHERE employee_number=$1',
        [existingWA.employee_number]
      );
      await pool.query(
        'DELETE FROM user_assignments WHERE employee_number=$1',
        [existingWA.employee_number]
      );
      await pool.query('DELETE FROM users WHERE id=$1', [existingWA.id]);
    }

    if (
      existingEmp &&
      existingEmp.whatsapp_number !== from &&
      !(existingEmp.approval_status === 'approved' && existingEmp.is_active === true)
    ) {
      await pool.query(
        'DELETE FROM user_special_permissions WHERE employee_number=$1',
        [d.employee_number]
      );
      await pool.query(
        'DELETE FROM user_assignments WHERE employee_number=$1',
        [d.employee_number]
      );
      await pool.query('DELETE FROM users WHERE id=$1', [existingEmp.id]);
    }

    await pool.query(
      `INSERT INTO users(
         whatsapp_number,name,employee_number,designation,
         area_of_working,section_department,responsibility,
         approval_status,is_active,updated_at
       )
       VALUES($1,$2,$3,$4,$5,$6,$7,'pending',true,now())
       ON CONFLICT(whatsapp_number)
       DO UPDATE SET
         name=EXCLUDED.name,
         employee_number=EXCLUDED.employee_number,
         designation=EXCLUDED.designation,
         area_of_working=EXCLUDED.area_of_working,
         section_department=EXCLUDED.section_department,
         responsibility=EXCLUDED.responsibility,
         approval_status='pending',
         is_active=true,
         updated_at=now()`,
      [
        from,
        d.name,
        d.employee_number,
        d.designation,
        d.area,
        d.section,
        d.responsibility
      ]
    );

    await pool.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  }
}

async function processMessage(from, text, rawMessage = null) {
  const te = isTe(text);
  let clean = String(text || '').trim();
  console.log('[FLOW]', from, clean);

  if (!pool) {
    await sendText(from, T('notfound', te));
    return;
  }

  if (await ownerCommand(from, clean)) return;

  // V7.7.23 routing guard: governance commands are private to Super Admin /
  // authorised admin routing. Never let a non-admin ACCESS command fall
  // through into employee/equipment/maintenance search. Silent by design.
  if (/^(?:ACCESS(?:\s+CONTROL)?|USER\s+CONTROL)(?:\b|:|_)/i.test(clean)) {
    return;
  }

  // Conversational acknowledgements must never execute stale equipment/search
  // context. Explicit follow-ups such as MORE, HISTORY, JOBS etc. continue to
  // use search context elsewhere in the router.
  if (/^(?:ok(?:ay)?|thanks?|thank\s+you|done|fine|got\s+it|👍|🙏)[.! ]*$/i.test(clean)) {
    await sendText(from, 'Is there anything else I can help you with?');
    return;
  }

  if (/^exit$/i.test(clean)) {
    await sendText(from, T('exit', te));
    return;
  }

  if (/^(remove me|delete me|remove my registration)$/i.test(clean)) {
    const removed = await deleteRegistrationByWA(from);
    if (!removed) {
      await sendText(from, T('notfound', te));
      return;
    }
    await sendText(from, T('removed', te));
    return;
  }

  const u = await byWA(from);

  if (!u) {
    if (/^(hi|hello|hey|start)$/i.test(clean)) {
      await sendText(from, T('register', te));
      return;
    }

    const d = parseReg(clean);
    if (!d) {
      await sendText(from, T('register', te));
      return;
    }

    const saved = await saveFreshRegistration(from, d);
    if (!saved.ok) {
      await sendText(from, 'Employee Number already active.');
      return;
    }

    await sendText(from, T('pending', te));
    const notified = await notifyAdmins(d);
    if (!notified) {
      console.error('[REGISTRATION] Pending saved; admin notification failed:', d.employee_number);
    }
    return;
  }

  // A pending user sees only pending status until approved/rejected.
  if (u.approval_status === 'pending') {
    await sendText(from, T('pending', te));
    return;
  }

  // Defensive fallback for old rejected/removed rows left from an earlier build:
  // registration details can replace them and start a fresh approval.
  if (
    u.approval_status === 'rejected' ||
    u.approval_status === 'removed' ||
    u.is_active === false
  ) {
    const d = parseReg(clean);
    if (!d) {
      await sendText(from, T('register', te));
      return;
    }

    await deleteRegistrationByWA(from);
    const saved = await saveFreshRegistration(from, d);

    if (!saved.ok) {
      await sendText(from, 'Employee Number already active.');
      return;
    }

    await sendText(from, T('pending', te));
    const notified = await notifyAdmins(d);
    if (!notified) {
      console.error('[REGISTRATION] Re-registration saved; admin notification failed:', d.employee_number);
    }
    return;
  }

  if (u.approval_status === 'approved') {
    let cm;

    // V6.1 batch recovery commands. Only failed/review/pending units are selected; completed units are preserved.
    let rr=clean.match(/^(RETRY|RESUME)\s*(?:UP[- ]?)?(\d+)$/i);
    if(rr){
      const mid=Number(rr[2]), m=(await pool.query(`SELECT * FROM media_ingestion WHERE id=$1`,[mid])).rows[0];
      if(!m || (!isOwner(from) && m.employee_number!==u.employee_number)){await sendText(from,'Batch not found.');return;}
      const pending=(await pool.query(`SELECT unit_type,unit_start,unit_end,status FROM ingestion_checkpoints WHERE media_ingestion_id=$1 AND status IN ('review','fallback','processing','pending') ORDER BY unit_start`,[mid])).rows;
      if(!pending.length){await sendText(from,`${m.batch_code||mediaBatchCode(mid)} has no pending/review units.`);return;}
      const cached=cachedSource(m.media_id,u.employee_number);
      if(!cached){await sendText(from,`⚠️ ${m.batch_code||mediaBatchCode(mid)} source file is no longer in the temporary cache. Completed indexed data is safe. Upload the same source once; future retries/resume can reuse it during the cache window.`);return;}
      await sendText(from,`⏳ ${rr[1].toUpperCase()} ${m.batch_code||mediaBatchCode(mid)} started • ${pending.length} pending/review checkpoint(s). Completed units will not be reprocessed.`);
      // Re-indexing uses existing document metadata and dedupe-safe chunk inserts.
      const kr=(await pool.query(`SELECT * FROM technical_document_knowledge WHERE media_ingestion_id=$1 ORDER BY id LIMIT 1`,[mid])).rows[0];
      if(!kr){await sendText(from,'Reference knowledge header not found for this batch.');return;}
      const obj={document_class:kr.document_class,title:kr.title,equipment_refs:kr.equipment_name?[kr.equipment_name]:[],identifiers:kr.identifiers||[],page_count:Math.max(...pending.map(x=>Number(x.unit_end)||1))};
      let ok=0,fail=[]; const ctx2=await currentShiftContext(u);
      for(const cp of pending){for(let p=Number(cp.unit_start);p<=Number(cp.unit_end);p++){
        try{await checkpoint(mid,cp.unit_type,p,p,'processing');const part=await withRetry(()=>extractReferenceRange(cached.buf,cached.mime,u,ctx2,obj,cached.name,p,p,null),4);
          for(const item of (part.reference_items||[])){const tx=String(item.text||'').trim();if(!tx)continue;await pool.query(`INSERT INTO technical_document_chunks(media_ingestion_id,knowledge_id,employee_number,document_class,title,equipment_name,identifiers,page_start,page_end,section_heading,content_text,source_filename,entered_by) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13 WHERE NOT EXISTS(SELECT 1 FROM technical_document_chunks WHERE media_ingestion_id=$1 AND page_start=$8 AND page_end=$9 AND coalesce(section_heading,'')=coalesce($10,'') AND content_text=$11)`,[mid,kr.id,u.employee_number,kr.document_class,kr.title,kr.equipment_name,JSON.stringify(kr.identifiers||[]),p,p,item.heading||null,tx,cached.name,from]);}
          await checkpoint(mid,cp.unit_type,p,p,'done');ok++;
        }catch(e){await checkpoint(mid,cp.unit_type,p,p,'review',e.message);fail.push(p);}
      }}
      await pool.query(`UPDATE media_ingestion SET review_count=$2,status=$3 WHERE id=$1`,[mid,fail.length,fail.length?'reference_partial':'reference_indexed']);
      await sendText(from,`✅ ${rr[1].toUpperCase()} complete • recovered ${ok} unit(s)${fail.length?` • ${fail.length} still need review: ${[...new Set(fail)].join(', ')}`:' • 0 review units remaining'}\nBatch ID: ${m.batch_code||mediaBatchCode(mid)}`);return;
    }

    // V7 explicit file-action routing. A document is never indexed/stored merely because it was uploaded.
    const fa=clean.trim().toUpperCase();
    // Background-job controls stay lightweight and never block normal conversation.
    if(/^(STATUS|JOBS|MY JOBS)$/i.test(clean.trim())){
      const q=await pool.query(`SELECT job_code,job_type,status,progress_current,progress_total,source_filename,last_error FROM background_jobs WHERE employee_number=$1 ORDER BY created_at DESC LIMIT 5`,[u.employee_number]);
      if(!q.rows.length){await sendText(from,'No recent background jobs.');return;}
      await sendText(from,q.rows.map(j=>`${j.job_code} • ${j.status.toUpperCase()} • ${j.source_filename||j.job_type}${j.progress_total?` • ${j.progress_current}/${j.progress_total}`:''}${j.status==='failed'&&j.last_error?`\n${String(j.last_error).slice(0,120)}`:''}`).join('\n\n'));return;
    }
    const retryJob=clean.trim().match(/^RETRY\s+(JOB-\d+)$/i);
    if(retryJob){const q=await pool.query(`UPDATE background_jobs SET status='queued',last_error=NULL,started_at=NULL,completed_at=NULL WHERE employee_number=$1 AND upper(job_code)=upper($2) AND status='failed' RETURNING *`,[u.employee_number,retryJob[1]]);if(!q.rows[0]){await sendText(from,'Failed job not found. Send STATUS to see recent jobs.');return;}await sendText(from,`🔄 ${q.rows[0].job_code} queued again. You can continue using the bot.`);setImmediate(()=>kickBackgroundWorker().catch(console.error));return;}

    const pendingFile=getPendingFileAction(u.employee_number);
    if(pendingFile && /^(FILE_(READ|STORE|READ_STORE|CONVERT|ALL)|READ FILE|STORE FILE|READ AND STORE)$/i.test(fa)){
      if(fa==='FILE_CONVERT'){
        const nm=String(pendingFile.meta.name||'');
        const kind=/\.tiff?$/i.test(nm)?'tiff':/\.(mdb|accdb)$/i.test(nm)?'access':/\.(xlsx?|xls)$/i.test(nm)?'excel':/\.csv$/i.test(nm)?'csv':null;
        if(kind==='excel'||kind==='csv'){const pm=pendingFile.meta;const meta=await mediaMeta(pm.mediaId);const buf=await mediaBytes(meta.url);const out=await spreadsheetConvertBuffer(buf,pm.name,kind==='excel'?'csv':'xlsx');clearPendingFileAction(u.employee_number);await sendDocumentBuffer(from,out.buffer,out.filename,`✅ ${kind==='excel'?'Excel → CSV':'CSV → Excel'} complete • ${out.sheets} sheet(s) • conversion only, not stored`,out.mime||'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');return;}
        if(!kind){ await sendText(from,'This file type has no conversion action configured. Choose Read or Store.'); return; }
        const pm=pendingFile.meta; await rememberDurableSource(u,from,pm.mediaId,pm.name,pm.mime,kind);
        const j=await enqueueConversionJob(u,from,pm.mediaId,pm.name,pm.mime,kind); clearPendingFileAction(u.employee_number);
        await sendText(from,`⏳ ${kind==='tiff'?'TIFF → PDF':'Access → Excel'} started in background • ${j.job_code}\nYou can continue using the bot. Send STATUS anytime.`); return;
      } else {
        // READ means analyse now without permanent knowledge/event storage. STORE/READ_STORE/ALL use the normal
        // guarded ingestion pipeline; reference docs go to knowledge, event docs keep equipment/date/user audit rules.
        if(fa==='FILE_READ'){
          const pm=pendingFile; const n=pm.msg.document; const meta=await mediaMeta(n.id); const buf=await mediaBytes(meta.url); const mime=meta.mime_type||n.mime_type||''; const name=n.filename||`document-${n.id}`; const ctx=await currentShiftContext(u);
          let obj;
          if(/pdf|tiff/i.test(mime)||/\.(pdf|tiff?)$/i.test(name)) obj=await extractDocument(buf,mime,u,ctx,name,null);
          else { const st=await extractOfficeOrAccess(buf,mime,name,u,ctx); obj=await classifyExtracted(st?.text||'',u,ctx); }
          await sendText(from,`📖 Read only — ${name}\n${String(obj?.summary||'File read successfully.').slice(0,3000)}\n\nNot stored. Choose Store if this source should become part of LMMM knowledge/history.`); return;
        }
        const doAll=fa==='FILE_ALL'; const allMeta=pendingFile.meta;
        clearPendingFileAction(u.employee_number);
        await stageMedia(u,from,pendingFile.msg);
        if(doAll){
          const nm=String(allMeta.name||''); const src=cachedSource(allMeta.mediaId,u.employee_number);
          try{
            if(/\.tiff?$/i.test(nm)){const out=await tiffToPdfBuffer(src.buf);await sendDocumentBuffer(from,out.buffer,nm.replace(/\.tiff?$/i,'.pdf'),`✅ TIFF → PDF complete • ${out.pages}/${out.pages} pages`);}
            else if(/\.(mdb|accdb)$/i.test(nm)){const out=await accessToExcelBuffer(src.buf);await sendDocumentBuffer(from,out.buffer,nm.replace(/\.(mdb|accdb)$/i,'.xlsx'),`${out.errors?.length?'⚠️ Access → Excel partial':'✅ Access → Excel complete'} • ${out.sheets}/${out.tables} tables • ${out.totalRows} rows${out.errors?.length?' • Failed: '+out.errors.slice(0,3).join(' | '):''}`,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');}
          }catch(e){await sendText(from,`⚠️ Storage completed, but conversion failed: ${String(e?.message||e).slice(0,180)}`);}
        }
        return;
      }
    }

    // Natural-language conversion commands use the durable latest source and only enqueue work.
    if(/^(?:ACCESS|MDB|ACCDB)\s*(?:TO|2)\s*(?:EXCEL|XLSX)$|^(?:EXCEL|XLSX)\s*(?:CHEYYI|CHEY|GA CONVERT CHEYYI|CONVERT)$/i.test(clean.trim())){
      const live=latestConvertible(u.employee_number,'access'); const d=live?null:await latestDurableSource(u.employee_number,'access');
      const src=live?{media_id:live.mediaId,filename:live.name,mime_type:live.mime}:d;
      if(!src){await sendText(from,'Access .mdb/.accdb file dorakaledu. Mundu file upload cheyyandi.');return;}
      const j=await enqueueConversionJob(u,from,src.media_id,src.filename,src.mime_type,'access');
      await sendText(from,`⏳ Access → Excel started in background • ${j.job_code}\nYou can continue using the bot. Send STATUS anytime.`);return;
    }
    if(/^(?:TIFF|TIF)\s*(?:TO|2)\s*PDF$|^PDF\s*(?:CHEYYI|CHEY|GA CONVERT CHEYYI|CONVERT)$/i.test(clean.trim())){
      const live=latestConvertible(u.employee_number,'tiff'); const d=live?null:await latestDurableSource(u.employee_number,'tiff');
      const src=live?{media_id:live.mediaId,filename:live.name,mime_type:live.mime}:d;
      if(!src){await sendText(from,'TIFF file dorakaledu. Mundu TIFF/TIF file upload cheyyandi.');return;}
      const j=await enqueueConversionJob(u,from,src.media_id,src.filename,src.mime_type,'tiff');
      await sendText(from,`⏳ TIFF → PDF started in background • ${j.job_code}\nYou can continue using the bot. Send STATUS anytime.`);return;
    }

    if(rawMessage && (rawMessage.image||rawMessage.audio||rawMessage.voice||rawMessage.document)){
      try{
        if(rawMessage.document){
          const n=rawMessage.document, meta=await mediaMeta(n.id), mime=meta.mime_type||n.mime_type||'', name=n.filename||`document-${n.id}`;
          const isTiff=/tiff/i.test(mime)||/\.tiff?$/i.test(name), isAccess=/access/i.test(mime)||/\.(mdb|accdb)$/i.test(name), isExcel=/spreadsheet|ms-excel/i.test(mime)||/\.(xlsx?|xls)$/i.test(name), isCsv=/csv/i.test(mime)||/\.csv$/i.test(name);
          // Fast intake: do not download a potentially huge TIFF/Access file merely to show its action menu.
          // The selected background/read job downloads the exact media only when needed.
          if(!(isTiff||isAccess||isExcel||isCsv)){ const buf=await mediaBytes(meta.url); cacheSource(u.employee_number,n.id,{buf,mime,name,mediaId:n.id,receivedAt:Date.now()}); }
          if(isTiff||isAccess||isExcel||isCsv){
            const kind=isTiff?'tiff':isAccess?'access':isExcel?'excel':'csv'; rememberLatestConvertible(u.employee_number,n.id,{mime,name,kind}); await rememberDurableSource(u,from,n.id,name,mime,kind);
            setPendingFileAction(u.employee_number,from,rawMessage,{mime,name,mediaId:n.id});
            const convertTitle=isTiff?'Convert to PDF':isAccess?'Convert to Excel':isExcel?'Convert to CSV':'Convert to Excel'; const storeConvertTitle=isTiff?'Store + PDF':isAccess?'Store + Excel':isExcel?'Store + CSV':'Store + Excel';
            const rows=[{id:'FILE_READ',title:'Read / Analyse',description:'Read now; do not store'},{id:'FILE_STORE',title:'Store',description:'Classify and store safely'},{id:'FILE_READ_STORE',title:'Read + Store',description:'Analyse and store'},{id:'FILE_CONVERT',title:convertTitle,description:'Conversion only; no storage'},{id:'FILE_ALL',title:storeConvertTitle,description:'Store safely and convert'}];
            await sendList(from,`📄 File received: ${name}\nNothing has been stored/indexed yet. Choose what you need.`,'Choose action',rows,'File actions');
          } else {
            // Direct-readable files should feel natural: process normally without an unnecessary conversion menu.
            await stageMedia(u,from,rawMessage);
          }
        } else await stageMedia(u,from,rawMessage);
      }catch(e){console.error('[MEDIA]',e);await sendText(from,`⚠️ File handling stopped. ${String(e?.message||'Unknown processing error').slice(0,180)}`);}
      return;
    }
    // Resolve date replies for pending media (e.g. Today / Yesterday / DD-MM-YYYY).
    // Apply the supplied date only to entries whose source had no readable date; never overwrite row dates extracted from a table.
    const pendingMedia=(await pool.query(`SELECT * FROM pending_media_confirmations WHERE employee_number=$1`,[u.employee_number])).rows[0];
    if(pendingMedia && !/^CONFIRM$|^CORRECT$/i.test(clean)){
      const suppliedDate=resolveUserDate(clean);
      if(suppliedDate){
        const proposed=typeof pendingMedia.proposed_json==='string'?JSON.parse(pendingMedia.proposed_json):pendingMedia.proposed_json;
        if(proposed.table_has_date_column){await sendText(from,'This is a historical dated table. Today/common date is blocked. Only unresolved rows are pending; send a clearer source or row-wise correction such as ROW 1 DATE 19-06-2005.');return;}
        const entries=(proposed.entries||[]).map(e=>e.event_date?e:{...e,event_date:suppliedDate,event_date_source:clean});
        const stillMissing=entries.some(e=>!e.event_date);
        const updated={...proposed,entries,needs_event_time:stillMissing,uncertain:stillMissing?Boolean(proposed.uncertain):false};
        await pool.query(`UPDATE pending_media_confirmations SET proposed_json=$2,created_at=now() WHERE employee_number=$1`,[u.employee_number,updated]);
        if(!stillMissing && !updated.uncertain){
          const saved=await commitMedia(u,from,{...pendingMedia,proposed_json:updated},'confirmed','user_supplied_media_date');
          await sendText(from,mediaSummary(saved,pendingMedia.media_ingestion_id,0));
          return;
        }
      }
    }

    if(/^CONFIRM$/i.test(clean)){
      const p=(await pool.query(`SELECT * FROM pending_media_confirmations WHERE employee_number=$1`,[u.employee_number])).rows[0];
      if(!p){await sendText(from,'Not found.');return;}
      const po=typeof p.proposed_json==='string'?JSON.parse(p.proposed_json):p.proposed_json;
      if((po.entries||[]).some(e=>!e.event_date)){await sendText(from,po.table_has_date_column?'Cannot confirm: one or more table row dates are missing. Send a clearer source or row-wise correction.':'Cannot confirm yet: event date is missing.');return;}
      await commitMedia(u,from,{...p,proposed_json:po});
      const l=p.proposed_json?.language||'en';
      await sendText(from,ml(l,'Saved.','సేవ్ అయింది.','सेव हो गया।'));return;
    }
    if(/^CORRECT$/i.test(clean)){
      await sendText(from,ml(languageOf(clean),'Send the correction in text.','సరిచేయాల్సిన వివరాన్ని టెక్స్ట్‌లో పంపండి.','सही जानकारी टेक्स्ट में भेजें।'));return;
    }

    // V5.4 record controls: audit-safe view/edit/delete/undo. Creator may control own records; owner may control all.
    let rc;
    if((rc=clean.match(/^VIEW\s+(?:UP-)?(\d+)$/i))){
      const mid=Number(rc[1]);
      const m=(await pool.query(`SELECT * FROM media_ingestion WHERE id=$1`,[mid])).rows[0];
      if(!m || (!isOwner(from) && m.employee_number!==u.employee_number)){await sendText(from,'Not found.');return;}
      const rows=(await pool.query(`SELECT id,event_type,equipment_name,event_date,event_shift,event_text,status,deleted_at FROM section_event_log WHERE source_media_ingestion_id=$1 ORDER BY id`,[mid])).rows;
      const live=rows.filter(x=>!x.deleted_at);
      const body=live.slice(0,25).map(x=>`#${x.id} | ${x.event_date?.toISOString?.().slice(0,10)||x.event_date} | ${x.equipment_name||'Unresolved'} | ${x.event_type}\n${x.event_text}`).join('\n\n');
      await sendText(from,`${m.batch_code||mediaBatchCode(mid)} | ${live.length} active record(s)${rows.length-live.length?` | ${rows.length-live.length} deleted`:''}\n\n${body||'No active section records.'}`);return;
    }
    if((rc=clean.match(/^(?:UNDO|DELETE BATCH)\s+(?:UP-)?(\d+)$/i))){
      const mid=Number(rc[1]); const m=(await pool.query(`SELECT * FROM media_ingestion WHERE id=$1`,[mid])).rows[0];
      if(!m || (!isOwner(from) && m.employee_number!==u.employee_number)){await sendText(from,'Not found.');return;}
      await pool.query('BEGIN'); try{
        await pool.query(`UPDATE section_event_log SET deleted_at=now(),deleted_by=$2,delete_reason='batch_undo',status='deleted' WHERE source_media_ingestion_id=$1 AND deleted_at IS NULL`,[mid,from]);
        await pool.query(`UPDATE production_delays SET deleted_at=now(),deleted_by=$2 WHERE source_media_ingestion_id=$1 AND deleted_at IS NULL`,[mid,from]);
        await pool.query(`UPDATE production_shift_logs SET deleted_at=now(),deleted_by=$2 WHERE source_media_ingestion_id=$1 AND deleted_at IS NULL`,[mid,from]);
        await pool.query(`UPDATE media_ingestion SET status='rolled_back',rolled_back_at=now(),rolled_back_by=$2 WHERE id=$1`,[mid,from]);
        await pool.query('COMMIT');
      }catch(e){await pool.query('ROLLBACK');throw e;}
      await sendText(from,`Rolled back ${m.batch_code||mediaBatchCode(mid)}. Source file and audit trail are preserved.`);return;
    }
    if((rc=clean.match(/^DELETE\s+(\d+)(?:\s+(.+))?$/i))){
      const id=Number(rc[1]),reason=rc[2]||'user_delete';
      const old=(await pool.query(`SELECT * FROM section_event_log WHERE id=$1`,[id])).rows[0];
      if(!old || old.deleted_at || (!isOwner(from) && old.employee_number!==u.employee_number)){await sendText(from,'Not found.');return;}
      await pool.query(`UPDATE section_event_log SET deleted_at=now(),deleted_by=$2,delete_reason=$3,status='deleted' WHERE id=$1`,[id,from,reason]);
      await pool.query(`INSERT INTO record_change_audit(record_table,record_id,action,before_json,employee_number,changed_by,reason) VALUES('section_event_log',$1,'delete',$2,$3,$4,$5)`,[id,old,u.employee_number,from,reason]);
      await sendText(from,`Deleted record #${id}. Audit history preserved.`);return;
    }
    if((rc=clean.match(/^EDIT\s+(\d+)\s*:\s*(.+)$/i))){
      const id=Number(rc[1]),replacement=rc[2].trim();
      const old=(await pool.query(`SELECT * FROM section_event_log WHERE id=$1`,[id])).rows[0];
      if(!old || old.deleted_at || (!isOwner(from) && old.employee_number!==u.employee_number)){await sendText(from,'Not found.');return;}
      // Optional leading date in correction; otherwise preserve existing event date. Equipment is never guessed/renamed here.
      const dm=replacement.match(/^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4})\s*[|,-]\s*(.+)$/);
      const nd=dm?isoDate(dm[1]):(old.event_date?.toISOString?.().slice(0,10)||old.event_date), nt=dm?dm[2].trim():replacement;
      if(dm && !nd){await sendText(from,'Invalid date. Use DD-MM-YYYY or YYYY-MM-DD.');return;}
      const q=await pool.query(`UPDATE section_event_log SET original_event_text=COALESCE(original_event_text,event_text),original_event_date=COALESCE(original_event_date,event_date),event_text=$2,event_date=$3,edited_at=now(),edited_by=$4,status='edited' WHERE id=$1 RETURNING *`,[id,nt,nd,from]);
      await pool.query(`INSERT INTO record_change_audit(record_table,record_id,action,before_json,after_json,employee_number,changed_by) VALUES('section_event_log',$1,'edit',$2,$3,$4,$5)`,[id,old,q.rows[0],u.employee_number,from]);
      await sendText(from,`Updated record #${id}. Previous value preserved in audit history.`);return;
    }

    // Common shift check-in for ALL sections. Explicit check-in is attendance evidence.
    const st=shiftToken(clean);
    if(st){
      await setShiftCheckin(u,st,from);
      await sendText(from,`${st==='GENERAL'?'General':st} Shift recorded. Attendance saved.`);
      return;
    }

    // Resolve a pending late/backdated section event.
    const pending=(await pool.query(`SELECT * FROM pending_event_entries WHERE employee_number=$1`,[u.employee_number])).rows[0];
    if(pending){
      let d=null,sh=null;
      const dm=clean.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}[-\/]\d{1,2}[-\/]\d{4})/);
      if(dm)d=isoDate(dm[1]);
      const sm=clean.match(/\b([ABC])\s*shift\b/i); if(sm)sh=sm[1].toUpperCase();
      if(d || sh){
        if(!d){await sendText(from,'Which date?');return;}
        if(!sh){await sendText(from,'Which shift?');return;}
        const id=await saveSectionEvent(u,from,pending.event_type,pending.event_text,d,sh,'user_confirmed_backdate');
        await pool.query(`DELETE FROM pending_event_entries WHERE employee_number=$1`,[u.employee_number]);
        await sendText(from,`Saved. ${pending.event_type} ID: ${id}`);
        return;
      }
    }

    // Resolve an active Universal Search ambiguity before treating a short numeric reply as anything else.
    if(/^\d+$/.test(clean)){
      try{const us=await universalSearch(clean,u);if(us?.text){await sendText(from,us.text);return;}}catch(e){console.error('[SEARCH CHOICE]',e);}
    }

    // Natural inspection / defect / job-action entry for every section.
    const et=classifySectionEvent(clean);
    if(et && !looksLikeRetrievalIntent(clean) && !/^PROD|^DELAY/i.test(clean)){
      if(looksLateOrUnclear(clean)){
        await pool.query(`INSERT INTO pending_event_entries(employee_number,event_type,event_text,section,area,responsibility)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(employee_number) DO UPDATE
          SET event_type=EXCLUDED.event_type,event_text=EXCLUDED.event_text,section=EXCLUDED.section,area=EXCLUDED.area,
              responsibility=EXCLUDED.responsibility,created_at=now()`,
          [u.employee_number,et,clean,u.section_department,u.area_of_working,await responsibilityName(u.employee_number)]);
        await sendText(from,'When did it happen? Send date and shift.');
        return;
      }
      const id=await saveSectionEvent(u,from,et,clean);
      const ctx=await currentShiftContext(u);
      await sendText(from,`Saved. ${et} ID: ${id}\nShift: ${ctx.shift||'Not found'}`);
      return;
    }

    // PROD ADD YYYY-MM-DD | Shift | Area | Blooms | Operations Shift In-charge | Remarks
    if ((cm=clean.match(/^PROD\s+ADD\s+(.+)$/i))) {
      const auth=await productionAuthority(u);
      if(!auth.enter){await sendText(from,'Not authorized.');return;}
      const p=cm[1].split('|').map(x=>x.trim());
      const d=isoDate(p[0]), blooms=Number(p[3]);
      if(p.length<4||!d||!p[1]||!p[2]||!Number.isInteger(blooms)||blooms<0){await sendText(from,'Format: PROD ADD Date | Shift | Area | Blooms | Operations Shift In-charge | Remarks');return;}
      const r=await pool.query(`INSERT INTO production_shift_logs(production_date,shift,area,blooms_rolled,operations_shift_incharge,remarks,entered_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [d,p[1],p[2],blooms,p[4]||u.name,p[5]||null,from]);
      await sendText(from,`Saved. Production ID: ${r.rows[0].id}\n${blooms} blooms ≈ ${blooms*4} t`);return;
    }

    // DELAY ADD ProductionID | Section | Minutes | Reason | Job/Action
    if ((cm=clean.match(/^DELAY\s+ADD\s+(.+)$/i))) {
      const auth=await productionAuthority(u);
      if(!auth.enter){await sendText(from,'Not authorized.');return;}
      const p=cm[1].split('|').map(x=>x.trim()), id=Number(p[0]), mins=Number(p[2]);
      if(p.length<4||!Number.isInteger(id)||!p[1]||!Number.isInteger(mins)||mins<0||!p[3]){await sendText(from,'Format: DELAY ADD ProductionID | Section | Minutes | Reason | Job/Action');return;}
      const exists=(await pool.query(`SELECT id FROM production_shift_logs WHERE id=$1`,[id])).rows[0];
      if(!exists){await sendText(from,'Not found.');return;}
      await pool.query(`INSERT INTO production_delays(production_log_id,delay_section,delay_minutes,reason,job_action,entered_by) VALUES($1,$2,$3,$4,$5,$6)`,[id,p[1],mins,p[3],p[4]||null,from]);
      await sendText(from,'Saved.');return;
    }

    // PROD EDIT ID | Blooms | Reason
    if ((cm=clean.match(/^PROD\s+EDIT\s+(.+)$/i))) {
      const auth=await productionAuthority(u);
      if(!auth.modify){await sendText(from,'Not authorized.');return;}
      const p=cm[1].split('|').map(x=>x.trim()),id=Number(p[0]),blooms=Number(p[1]);
      if(p.length<3||!Number.isInteger(id)||!Number.isInteger(blooms)||blooms<0||!p[2]){await sendText(from,'Format: PROD EDIT ID | Blooms | Correction reason');return;}
      const old=(await pool.query(`SELECT * FROM production_shift_logs WHERE id=$1`,[id])).rows[0];
      if(!old){await sendText(from,'Not found.');return;}
      const nr=(await pool.query(`UPDATE production_shift_logs SET blooms_rolled=$2,updated_at=now() WHERE id=$1 RETURNING *`,[id,blooms])).rows[0];
      await pool.query(`INSERT INTO production_change_audit(production_log_id,old_data,new_data,change_reason,changed_by) VALUES($1,$2,$3,$4,$5)`,[id,old,nr,p[2],from]);
      await sendText(from,`Updated. ${old.blooms_rolled} → ${blooms} blooms`);return;
    }

    // YYYY-MM-DD production / DD-MM-YYYY production / AREA production DATE
    if ((cm=clean.match(/^(.+?)\s+production$/i))) {
      const d=isoDate(cm[1]);
      if(d){await sendText(from,await productionSummary(d));return;}
    }
    if ((cm=clean.match(/^(.+?)\s+production\s+(.+)$/i))) {
      const d=isoDate(cm[2]);
      if(d){await sendText(from,await productionSummary(d,cm[1]));return;}
    }
    if ((cm=clean.match(/^(.+?)\s+production\s+(?:in\s+)?tonnes?\s+(.+)$/i))) {
      const d=isoDate(cm[2]);
      if(d){await sendText(from,await productionSummary(d,cm[1]));return;}
    }

    if (/^(hi|hello|hey|start)$/i.test(clean)) {
      await sendText(from,T('help',te)); return;
    }
    if ((cm=clean.match(/^(.+?)\s+details$/i)) || (cm=clean.match(/^employee\s+(.+)$/i))) {
      const rows=await employeeSearch(cm[1]);
      if(!rows.length){await sendText(from,T('notfound',te));return;}
      if(rows.length===1){if(isSuperAdminWA(from)){await sendAccessAdminMenu(from,rows[0].employee_number);}else{await sendText(from,await profileText(rows[0]));}return;}
      await sendList(from,'Select employee','Select',rows.map(x=>({id:`EMPDETAIL:${x.employee_number}`,title:String(x.name).slice(0,24),description:`Emp No: ${x.employee_number}`})),'Employees');return;
    }
    if ((cm=clean.match(/^EMPDETAIL:(\d+)$/i))) {
      const rows=await employeeSearch(cm[1]);if(!rows[0]){await sendText(from,T('notfound',te));return;}if(isSuperAdminWA(from))await sendAccessAdminMenu(from,rows[0].employee_number);else await sendText(from,await profileText(rows[0]));return;
    }
    if ((cm=clean.match(/^MAX\s+(\d+)\s+(.+)$/i))) {
      await sendText(from,(await saveMax(from,cm[1],cm[2]))?'Saved.':T('notfound',te));return;
    }
    if ((cm=clean.match(/^EMAIL\s+(\d+)\s+(\S+)$/i))) {
      await sendText(from,(await saveEmail(from,cm[1],cm[2]))?'Saved.':T('notfound',te));return;
    }
    if ((cm=clean.match(/^(.+?)\s+(?:max|telephone)\s*(?:number|no)?$/i))) {
      const rows=await employeeSearch(cm[1]);await sendText(from,rows.length===1?`${rows[0].name}\nMAX No: ${rows[0].max_number||'Not found'}`:T('notfound',te));return;
    }
    if ((cm=clean.match(/^(.+?)\s+(?:mail|email)(?:\s+id)?$/i))) {
      const rows=await employeeSearch(cm[1]);await sendText(from,rows.length===1?`${rows[0].name}\nCompany Email: ${rows[0].company_email||'Not found'}`:T('notfound',te));return;
    }
    if ((cm=clean.match(/^EMERGENCY\s+MAX\s+(.+?)\s+([0-9+\-()\/ ]{2,30})$/i))) {
      await sendText(from,(await saveEmergency(from,cm[1],cm[2]))?'Saved.':T('notfound',te));return;
    }
    if (/^emergency\s+(?:max\s+)?numbers?$/i.test(clean)) {
      const rows=(await pool.query(`SELECT contact_name,max_number FROM emergency_contacts ORDER BY contact_name LIMIT 50`)).rows;
      await sendText(from,rows.length?rows.map(x=>`${x.contact_name}: ${x.max_number}`).join('\n'):T('notfound',te));return;
    }
    if ((cm=clean.match(/^(.+?)\s+emergency\s+(?:max\s+)?(?:number|no)?$/i))) {
      const rows=(await pool.query(`SELECT contact_name,max_number FROM emergency_contacts WHERE LOWER(contact_name) LIKE LOWER($1) ORDER BY contact_name LIMIT 10`,[`%${cm[1]}%`])).rows;
      await sendText(from,rows.length?rows.map(x=>`${x.contact_name}: ${x.max_number}`).join('\n'):T('notfound',te));return;
    }

    // V7.7.24 equipment-aware dynamic multi-select data menu.
    if(/^SEARCH_DATA_MENU$/i.test(clean)){await sendEquipmentDataMenu(from,u);return;}
    if((cm=clean.match(/^DATA_TOGGLE:([A-Z_]+)$/i))){
      const ctx=await getSearchContext(u);if(!ctx?.equipment_name){await sendText(from,'Select/search an equipment first.');return;}
      const av=await equipmentDataAvailability(ctx,u);if(!DATA_MENU_OPTIONS.some(x=>x[0]===cm[1].toUpperCase())||!(av.counts[cm[1].toUpperCase()]>0)){await sendText(from,'That option is not available for the current equipment/data.');return;}
      const picked=await selectionToggle(u.employee_number,'EQUIPMENT_DATA',ctx.equipment_name,cm[1].toUpperCase(),[]);
      await selectionReset(u.employee_number,'EQUIPMENT_DATA',ctx.equipment_name,picked,{applied:false});
      await sendEquipmentDataMenu(from,u);return;
    }
    if(/^DATA_APPLY$/i.test(clean)){await applyEquipmentDataSelection(from,u);return;}

    // V7.7.5: analysis-menu selections act on the active search context before Universal Search.
    try{
      const aa=await analysisAction(clean,u);
      if(aa?.handled)return;
      if(aa?.text){ if(aa.buttons?.length) await sendSearchTextAndButtons(from,aa.text,aa.buttons); else await sendLongText(from,aa.text); return; }
    }catch(e){console.error('[ANALYSIS ACTION]',e); await sendText(from,'Analysis could not be completed safely for the current filters.'); return;}
    // V7.4 Universal Search: structured history first, ambiguity-safe equipment resolution, then manuals/reference knowledge.
    try{
      const us=await universalSearch(clean,u);
      if(us?.dateMenu){await sendList(from,us.text,'Select',[
        {id:'Today',title:'Today'},{id:'Yesterday',title:'Yesterday'},{id:'Last 7 days',title:'Last 7 Days'},
        {id:'Last 30 days',title:'Last 30 Days'},{id:'This month',title:'This Month'},{id:'CUSTOM_DATE_RANGE',title:'Custom Range'}
      ],'Date Range');return;}
      if(us?.analysisMenu){const perms=await searchPermissions(u);const rows=allowedAnalysisRows(perms);if(!rows.length){await sendText(from,'No analysis options are available for your access level.');return;}await sendList(from,us.text,'Select',rows.slice(0,10),'Options');return;}
      if(us?.text){
        if(us.buttons?.length) await sendSearchTextAndButtons(from,us.text,us.buttons);
        else await sendLongText(from,us.text);
        // Print-access UX: an initial structured equipment/module search returns the WhatsApp list first,
        // then automatically creates the printable A4 report for the same active filters.
        // Do not auto-regenerate on More, date-menu commands, Analysis, or no-data responses.
        try{
          const p=await searchPermissions(u), c=await getSearchContext(u);
          const isControl=/^(more|next|search_more|analysis|search_analysis|select data|search_data_menu|date range|search_date)$/i.test(clean);
          if(p.pdf && us.status==='OK' && c?.equipment_name && c?.module && Number(c.page_offset||0)===0 && !isControl){
            await sendCurrentMaintenancePdf(from,u);
          }
        }catch(pe){console.error('[AUTO PRINT PDF]',pe);}
        return;
      }
      const kq=us?.knowledgeQuery||clean;
      const knowledgeRows=await retrieveReferenceKnowledge(kq,u);
      if(knowledgeRows.length){
        const answer=await geminiAnswerFromKnowledge(kq,knowledgeRows,u);
        if(answer){await sendText(from,answer);return;}
      }
      if(us?.status==='NO_STRUCTURED_DATA'){await sendText(from,'No authorised stored records were found for the current equipment/module/date filters. Try Date Range, change equipment, or clear the filter.');return;}
    }catch(e){console.error('[UNIVERSAL SEARCH]',e); await sendText(from,'Search could not be completed due to a system error. Please retry.'); return;}
    await sendText(from,ml(languageOf(clean),'No matching stored LMMM record or indexed reference knowledge was found. Try an equipment name, item number, maintenance term, or another date range.','సరిపోలే LMMM రికార్డు లేదా ఇండెక్స్ చేసిన రిఫరెన్స్ సమాచారం దొరకలేదు. Equipment పేరు, item number, maintenance term లేదా మరో date range తో ప్రయత్నించండి.','मिलता हुआ LMMM रिकॉर्ड या indexed reference knowledge नहीं मिला। Equipment name, item number, maintenance term या दूसरी date range से खोजें।'));return;
  }

  await sendText(from, T('notfound', te));
}

app.get('/', (_q, r) =>
  r.status(200).json({
    ok: true,
    service: 'LMMM WhatsApp AI Maintenance Agent',
    status: 'live',
    webhook: '/webhook'
  })
);

app.get('/health', async (_q, r) => {
  if(!converterHealth.checked) await checkConverterHealth();
  r.status(200).json({
    ok: true,
    database_configured: Boolean(DATABASE_URL),
    phone_number_id_configured: Boolean(PHONE_NUMBER_ID),
    access_token_configured: Boolean(ACCESS_TOKEN),
    super_admins_configured: SUPER_ADMIN_NUMBERS.size,
    converters: { tiff_to_pdf: converterHealth.tiff_pdf, access_to_excel: converterHealth.access_excel },
    converter_errors: converterHealth.errors
  });
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = String(req.query['hub.verify_token'] ?? '').trim();
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
    return res.status(200).send(String(challenge));
  }
  return res.status(403).send('Forbidden');
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200);

  (async () => {
    try {
      console.log('WHATSAPP WEBHOOK:', JSON.stringify(req.body));
      const m = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!m) return;

      let text = '';
      if (m.type === 'text') {
        text = m.text?.body || '';
      } else if (m.type === 'interactive') {
        text = m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || '';
      }

      console.log('[MESSAGE]', { from: m.from, type: m.type, text });

      const hasMedia = !!(m.image || m.audio || m.voice || m.document);
      if (!text && !hasMedia) {
        await sendText(m.from, 'Not found.');
        return;
      }

      await processMessage(m.from, text, m);
    } catch (e) {
      console.error('[WEBHOOK ERROR]', e);
    }
  })();
});

app.get('/api/status', (_q, r) =>
  r.status(200).json({
    status: 'ready',
    registration: 'V7.7.24-project-wide-dynamic-multiselect',
    webhook: '/webhook',
    super_admins_configured: SUPER_ADMIN_NUMBERS.size
  })
);

app.use((_q, r) => r.status(404).send('Not found'));

initDB().then(()=>setTimeout(()=>kickBackgroundWorker().catch(e=>console.error('[BG STARTUP]',e)),1500)).catch(e => console.error('[DATABASE INIT ERROR]', e));

const server = http.createServer(app);
server.on('error', (err) => {
  console.error('[SERVER ERROR]', err);
  process.exitCode = 1;
});
server.listen(PORT, HOST, () => {
  const address = server.address();
  console.log(`[SERVER] listening on ${HOST}:${PORT}`);
  console.log('[SERVER] address:', address);
  console.log(`[SERVER] health: http://127.0.0.1:${PORT}/health`);
});
