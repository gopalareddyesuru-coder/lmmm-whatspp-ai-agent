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

async function effectiveAuthority(employeeNumber) {
  const ur = await pool.query(
    `SELECT employee_number,designation,section_department,area_of_working,approval_status,is_active
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

  const pr = await pool.query(
    `SELECT permission FROM user_special_permissions
     WHERE employee_number=$1 AND active=true`,
    [employeeNumber]
  );

  const roles = rr.rows.map(x => String(x.responsibility_role || '').trim().toLowerCase());
  const hod = roles.includes('hod');
  const sectionIncharge = roles.includes('section in-charge') || roles.includes('section incharge');
  const areaIncharge = roles.includes('area in-charge') || roles.includes('area incharge');
  const band = designationBand(u.designation);
  const category = employeeCategory(u.designation);

  let effectiveAccess = category === 'EXECUTIVE' ? 'ENTRY_VIEW' : 'ENTRY';
  let scope = 'REGISTERED_SCOPE';

  // DGM gets full access only to the assigned/registered section.
  if (band === 'DGM') {
    effectiveAccess = 'FULL';
    scope = 'ASSIGNED_SECTION';
  }
  // Responsibility overrides designation assumptions.
  if (areaIncharge) scope = 'ASSIGNED_AREA';
  if (sectionIncharge) {
    effectiveAccess = 'FULL';
    scope = 'ASSIGNED_SECTION';
  }
  // HOD can be DGM, GM, or another authorized designation: HOD responsibility controls scope.
  if (hod) {
    effectiveAccess = 'FULL';
    scope = 'ALL_SECTIONS';
  }

  return {
    employee_number: u.employee_number,
    designation: u.designation,
    employee_category: category,
    designation_band: band,
    registered_section: u.section_department,
    registered_area: u.area_of_working,
    responsibilities: rr.rows,
    effective_access: effectiveAccess,
    scope,
    special_permissions: pr.rows.map(x => x.permission)
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

  await sendButtons(
    from,
    `Responsibility set\n${u.name} / ${employeeNumber}\n${role}\nSection: ${section}\nArea: ${area}`,
    [
      {id:`RESP_CHANGE:${employeeNumber}`,title:'Change'},
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
 const resp=(a?.responsibility_roles||[])[0]?.responsibility_role||u.responsibility||'Not found';
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
 const owner=isOwner(u.wa_number);
 const a=await effectiveAuthority(u.employee_number);
 const roles=(a?.responsibility_roles||[]).map(x=>String(x.responsibility_role||'').toLowerCase());
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
  return (a?.responsibility_roles||[])[0]?.responsibility_role || 'Normal Employee';
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
  // LMMM user language aliases; only deterministic plant terminology, never identifier rewriting in stored data.
  x=x.replace(/\bfurnace\s*[- ]?1\b/ig,'WBF-1').replace(/\bfurnace\s*[- ]?2\b/ig,'WBF-2');
  x=x.replace(/\bwalking\s+beam\s+furnace\s*[- ]?1\b/ig,'WBF-1').replace(/\bwalking\s+beam\s+furnace\s*[- ]?2\b/ig,'WBF-2');
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
async function searchBundledMaster(question,limit=12){
  const q=naturalSearchAliases(question), intent=searchIntent(q), entity=stripIntentWords(q);
  const vals=[]; let where='TRUE';
  if(intent==='defect'){vals.push('defect');where+=` AND record_type=$${vals.length}`;}
  else if(intent==='history'){vals.push('history');where+=` AND record_type=$${vals.length}`;}
  else if(intent==='spares'){vals.push('spare');where+=` AND record_type=$${vals.length}`;}
  const terms=queryTokens(entity||q).slice(0,6);
  if(terms.length){
    const ors=[];
    for(const t of terms){vals.push(`%${t}%`);ors.push(`(LOWER(COALESCE(equipment,'')) LIKE LOWER($${vals.length}) OR LOWER(record_text) LIKE LOWER($${vals.length}))`);}
    where+=` AND (${ors.join(' OR ')})`;
  }
  vals.push(limit);
  const rows=(await pool.query(`SELECT uid,record_type,equipment,area,event_date,record_text,source_name FROM lmmm_master_records WHERE ${where} ORDER BY event_date DESC NULLS LAST, uid LIMIT $${vals.length}`, vals.length>1?vals:[...vals])).rows;
  if(rows.length)return rows;
  const ids=[...new Set(String(q).toUpperCase().match(/\b(?:[A-Z]{1,8}[-_/])?[A-Z0-9]{2,}(?:[-_/.][A-Z0-9]+)*\b/g)||[])];
  const kt=queryTokens(q).slice(0,5); if(!ids.length&&!kt.length)return [];
  const kv=[];const kc=[];
  if(ids.length){kv.push(ids);kc.push(`identifiers && $1::text[]`);}
  for(const t of kt){kv.push(`%${t}%`);kc.push(`LOWER(normalized_text) LIKE LOWER($${kv.length})`);}
  kv.push(limit);
  return (await pool.query(`SELECT uid,'knowledge' AS record_type,NULL::text AS equipment,NULL::text AS area,NULL::text AS event_date,raw_text AS record_text,source_name FROM lmmm_knowledge_records WHERE ${kc.join(' OR ')} LIMIT $${kv.length}`,kv)).rows;
}
function formatBundledResults(rows){
  if(!rows?.length)return null;
  return rows.slice(0,10).map(r=>{
    const h=[r.event_date,r.equipment,r.record_type].filter(Boolean).join(' | ');
    return `${h?`${h}\n`:''}${String(r.record_text||'').slice(0,700)}${r.source_name?`\nSource: ${r.source_name}`:''}`;
  }).join('\n\n');
}

function queryTokens(t=''){
 return [...new Set(String(t).toLowerCase().replace(/[^a-z0-9_\-\/\.\s]/g,' ').split(/\s+/).filter(x=>x.length>=2 && !['the','and','for','with','what','tell','about','show','give','please','data','details','lo','ki','ga','ani'].includes(x)))].slice(0,12);
}
// V7.4 user-first universal maintenance search. Never guess a specific asset when several match.
const GENERIC_ASSET_WORDS=/\b(pump|pumps|gear\s*box|gearbox|gearboxes|coupling|couplings|motor|motors|bearing|bearings|valve|valves|pipe|pipes|pipeline|stand|stands|roll|rolls|guide|guides|cylinder|cylinders|fan|fans|blower|blowers|recup|recuperator|compressor|compressors)\b/i;
function searchIntent(q=''){
 const t=String(q).toLowerCase();
 if(/\b(defect|defects|fault|faults|problem|problems)\b/.test(t))return 'defect';
 if(/\b(job|jobs|work\s*order|maintenance\s*job)\b/.test(t))return 'job_action';
 if(/\b(inspection|condition|vibration|cbm)\b/.test(t))return 'condition';
 if(/\b(shutdown)\b/.test(t))return 'shutdown';
 if(/\b(history|previous|old|past)\b/.test(t))return 'history';
 if(/\b(spare|spares|inventory|stock)\b/.test(t))return 'spares';
 if(/\b(drawing|drawings|drg)\b/.test(t))return 'drawing';
 if(/\b(pm|preventive|schedule|scheduled|rcm|reliability)\b/.test(t))return 'maintenance';
 return 'general';
}
function stripIntentWords(q=''){
 return String(q).replace(/\b(defects?|faults?|problems?|jobs?|work\s*orders?|history|previous|old|past|inspection|condition|monitoring|vibration|cbm|shutdown|spares?|inventory|stock|drawings?|drg|manuals?|details?|about|tell|show|find|search|cheppu|gurinchi|pm|preventive|scheduled?|maintenance|rcm|reliability)\b/ig,' ').replace(/\s+/g,' ').trim();
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
 vals.push(contextArea); const areaP=`$${n++}`;
 const sql=`WITH eq AS (\n   SELECT DISTINCT equipment_name AS name, area FROM section_event_log WHERE deleted_at IS NULL AND equipment_name IS NOT NULL\n   UNION SELECT DISTINCT equipment_name AS name, NULL::text AS area FROM technical_document_chunks WHERE equipment_name IS NOT NULL\n ) SELECT name,area FROM eq WHERE (${clauses.join(' OR ')})\n ORDER BY CASE WHEN ${areaP} IS NOT NULL AND LOWER(COALESCE(area,''))=LOWER(${areaP}) THEN 0 ELSE 1 END, name LIMIT 12`;
 return (await pool.query(sql,vals)).rows;
}
async function eventSearch(q,u,equipment=null){
 const intent=searchIntent(q), terms=queryTokens(stripIntentWords(q)); const vals=[]; let where=`deleted_at IS NULL`;
 if(equipment){vals.push(equipment);where+=` AND (LOWER(COALESCE(equipment_name,''))=LOWER($${vals.length}) OR LOWER(event_text) LIKE LOWER('%'||$${vals.length}||'%'))`;}
 for(const t of terms.slice(0,5)){vals.push(t);where+=` AND LOWER(event_text||' '||COALESCE(equipment_name,'')) LIKE LOWER('%'||$${vals.length}||'%')`;}
 if(intent==='defect'||intent==='job_action'){vals.push(intent);where+=` AND event_type=$${vals.length}`;}
 const r=await pool.query(`SELECT id,event_type,equipment_name,event_date,event_shift,event_text FROM section_event_log WHERE ${where} ORDER BY event_date DESC,entered_at DESC LIMIT 12`,vals);
 return r.rows;
}
async function universalSearch(q,u){
 const original=String(q||'').trim(); if(!original)return null;
 // Numeric choice is accepted only while an ambiguity prompt is pending.
 if(/^\d+$/.test(original)){
   const pr=(await pool.query(`SELECT * FROM pending_search_choices WHERE employee_number=$1 AND created_at>now()-interval '30 minutes'`,[u.employee_number])).rows[0];
   if(pr){const choices=typeof pr.choices==='string'?JSON.parse(pr.choices):pr.choices;const pick=choices[Number(original)-1];if(pick){await setSearchContext(u,pick.name,pick.area||null);await pool.query(`DELETE FROM pending_search_choices WHERE employee_number=$1`,[u.employee_number]);const rows=await eventSearch(pr.original_query,u,pick.name);if(rows.length)return {text:`${pick.name}\n\n`+rows.map(x=>`${x.event_date?.toISOString?.().slice(0,10)||x.event_date} | ${x.event_type}${x.event_shift?` | ${x.event_shift}`:''}\n${x.event_text}`).join('\n\n')};return {rerun:pr.original_query,equipment:pick.name};}}
 }
 const ctx=await getSearchContext(u); let entity=stripIntentWords(original); const alias=await resolveAlias(entity); if(alias)entity=alias.equipment_name||alias.canonical_text;
 // If the user supplies only an intent after selecting an asset, retain that asset context.
 if(!entity && ctx?.equipment_name)entity=ctx.equipment_name;
 const candidates=entity?await equipmentCandidates(entity,ctx):[];
 if(candidates.length>1 && (GENERIC_ASSET_WORDS.test(entity)||candidates.every(x=>String(x.name).toLowerCase()!==String(entity).toLowerCase()))){
   await pool.query(`INSERT INTO pending_search_choices(employee_number,original_query,choices,created_at) VALUES($1,$2,$3,now()) ON CONFLICT(employee_number) DO UPDATE SET original_query=EXCLUDED.original_query,choices=EXCLUDED.choices,created_at=now()`,[u.employee_number,original,JSON.stringify(candidates)]);
   return {text:`Multiple matches found. Which one?\n\n`+candidates.map((x,i)=>`${i+1}. ${x.name}${x.area?` — ${x.area}`:''}`).join('\n')};
 }
 const equipment=candidates.length===1?candidates[0].name:(ctx?.equipment_name && !entity?ctx.equipment_name:null);
 if(equipment)await setSearchContext(u,equipment,candidates[0]?.area||ctx?.area||null);
 const events=await eventSearch(original,u,equipment);
 if(events.length){return {text:(equipment?`${equipment}\n\n`:'')+events.map(x=>`${x.event_date?.toISOString?.().slice(0,10)||x.event_date} | ${x.event_type}${x.event_shift?` | ${x.event_shift}`:''}\n${x.event_text}`).join('\n\n')};}
 const masterRows=await searchBundledMaster(original,12);
 if(masterRows.length)return {text:formatBundledResults(masterRows)};
 // Let reference/manual search answer next, but enrich a follow-up with selected equipment.
 return {knowledgeQuery:equipment && !original.toLowerCase().includes(equipment.toLowerCase())?`${equipment} ${original}`:original};
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
 return r.rows;
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

async function ownerCommand(from, text) {
  const admin = from.replace(/\D/g, '');
  if (!SUPER_ADMIN_NUMBERS.has(admin)) return false;

  text = String(text || '').replace(/^APPROVE:(\d+)$/i, 'approve $1').replace(/^REJECT:(\d+)$/i, 'reject $1').replace(/^CONFIRM_REMOVE:(\d+)$/i, 'confirm remove $1').replace(/^CANCEL_REMOVE:(\d+)$/i, 'cancel remove $1').replace(/^CONFIRM_RESET$/i, 'confirm reset registrations').replace(/^CANCEL_RESET$/i, 'cancel reset registrations');

  let rx;
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

    await sendText(u.whatsapp_number, 'Welcome to LMMM AI Maintenance.');
    if (from.replace(/\D/g, '') !== u.whatsapp_number.replace(/\D/g, '')) {
      await sendButtons(
        from,
        `Registration approved\n${u.name} / ${u.employee_number}`,
        [
          {id:`RESP_CHANGE:${u.employee_number}`,title:'Set Responsibility'},
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

  m = text.match(/^(grant|revoke)\s+(\d+)\s+(PRINT_EXPORT|ADVANCED_REPORTS|FULL_ACCESS)$/i);
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
      if(rows.length===1){await sendText(from,await profileText(rows[0]));return;}
      await sendList(from,'Select employee','Select',rows.map(x=>({id:`EMPDETAIL:${x.employee_number}`,title:String(x.name).slice(0,24),description:`Emp No: ${x.employee_number}`})),'Employees');return;
    }
    if ((cm=clean.match(/^EMPDETAIL:(\d+)$/i))) {
      const rows=await employeeSearch(cm[1]);await sendText(from,rows[0]?await profileText(rows[0]):T('notfound',te));return;
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
    // V7.4 Universal Search: structured history first, ambiguity-safe equipment resolution, then manuals/reference knowledge.
    try{
      const us=await universalSearch(clean,u);
      if(us?.text){await sendText(from,us.text);return;}
      const kq=us?.knowledgeQuery||clean;
      const knowledgeRows=await retrieveReferenceKnowledge(kq,u);
      if(knowledgeRows.length){
        const answer=await geminiAnswerFromKnowledge(kq,knowledgeRows,u);
        if(answer){await sendText(from,answer);return;}
      }
    }catch(e){console.error('[UNIVERSAL SEARCH]',e);}
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
    registration: 'V7.5-master-sync-universal-search',
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
