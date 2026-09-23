// LMMM AI Maintenance V8.13.8 TIFF ADAPTIVE DISK-CACHE + WEBHOOK IDEMPOTENCY
// CLEAN REBUILD - PHASE 1: REGISTRATION / APPROVAL / USER LIFECYCLE ONLY
import express from 'express';
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const app = express();
app.use(express.json({limit:'5mb'}));

const PORT = Number(process.env.PORT || 10000);
const VERIFY_TOKEN = String(process.env.META_VERIFY_TOKEN || '').trim();
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || '';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6';
const FREE_AI_ONLY = String(process.env.FREE_AI_ONLY ?? 'true').toLowerCase() !== 'false';
const OPENAI_ENABLED = !FREE_AI_ONLY && !!OPENAI_API_KEY;

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const SUPER_ADMINS = new Set(
  String(process.env.SUPER_ADMIN_NUMBERS || process.env.SUPER_ADMIN_NUMBER || process.env.OWNER_NUMBERS || process.env.OWNER_NUMBER || '')
  .split(',').map(x=>x.replace(/\D/g,'')).filter(Boolean)
);
const pool = DATABASE_URL ? new Pool({connectionString:DATABASE_URL, ssl:DATABASE_URL.includes('localhost')?false:{rejectUnauthorized:false}}) : null;
const normWA = x => String(x||'').replace(/\D/g,'');

function isOwner(wa){ return SUPER_ADMINS.has(normWA(wa)); }
function canonicalDesignation(v=''){
  const raw=String(v||'').trim(); if(!raw) return null;
  const k=raw.toLowerCase().replace(/[._-]+/g,' ').replace(/\s+/g,' ').trim();
  const aliases = {
    'mt':'Management Trainee','management trainee':'Management Trainee',
    'jr mgr':'Junior Manager','junior mgr':'Junior Manager','junior manager':'Junior Manager',
    'asst mgr':'Assistant Manager','assistant mgr':'Assistant Manager','assistant manager':'Assistant Manager',
    'dy mgr':'Deputy Manager','deputy mgr':'Deputy Manager','deputy manager':'Deputy Manager',
    'mgr':'Manager','manager':'Manager',
    'sr mgr':'Senior Manager','senior mgr':'Senior Manager','senior manager':'Senior Manager',
    'agm':'Assistant General Manager','assistant general manager':'Assistant General Manager',
    'dgm':'Deputy General Manager','deputy general manager':'Deputy General Manager',
    'gm':'General Manager','general manager':'General Manager',
    'cgm':'Chief General Manager','chief general manager':'Chief General Manager',
    'ed':'Executive Director','executive director':'Executive Director',
    'cmd':'CMD','technician':'Technician','tech':'Technician','chargeman':'Chargeman',
    'foreman':'Foreman','acting foreman':'Acting Foreman','acting fm':'Acting Foreman','kalasi':'Kalasi'
  };
  return aliases[k] || raw.replace(/\b\w/g,c=>c.toUpperCase());
}
const LMMM_ORG = {
  department_code:'35',
  areas:['LMMM','BDM','BAR MILL','FINISHING','ADDITIONAL AREAS','CRANES','HYDRAULICS','PLANNING'],
  sections:['HOD','Operations','Mechanical','Electrical','Instrumentation','ETL','Telecommunications','Water Management','DNW','EnMD','RED']
};
function normKey(v=''){return String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function canonicalArea(v=''){
  const k=normKey(v), m={
    'lmmm':'LMMM','department':'LMMM','dept':'LMMM','department 35':'LMMM','dept 35':'LMMM',
    'bdm':'BDM','break down mill':'BDM','breakdown mill':'BDM','billet mill':'BDM','b d m':'BDM',
    'bar mill':'BAR MILL','barmill':'BAR MILL','bm':'BAR MILL',
    'finishing':'FINISHING','finishing mill':'FINISHING','finish':'FINISHING',
    'additional area':'ADDITIONAL AREAS','additional areas':'ADDITIONAL AREAS',
    'crane':'CRANES','cranes':'CRANES','cranes and aux':'CRANES','cranes aux':'CRANES',
    'hydraulic':'HYDRAULICS','hydraulics':'HYDRAULICS','planning':'PLANNING'
  }; return m[k]||String(v||'').trim().toUpperCase();
}
function canonicalSection(v=''){
  const k=normKey(v);
  const aliases={
    'hod':'HOD','head of department':'HOD','department head':'HOD',
    'mech':'Mechanical','mechanical':'Mechanical','me':'Mechanical',
    'ops':'Operations','operation':'Operations','operations':'Operations','production':'Operations',
    'elec':'Electrical','elect':'Electrical','electrical':'Electrical',
    'inst':'Instrumentation','instrument':'Instrumentation','instrumentation':'Instrumentation',
    'etl':'ETL','telecom':'Telecommunications','telecommunications':'Telecommunications',
    'water':'Water Management','water management':'Water Management','wm':'Water Management',
    'dnw':'DNW','enmd':'EnMD','en md':'EnMD','red':'RED'
  };
  return aliases[k]||String(v||'').trim();
}
function canonicalDesignationV83(v=''){
  const k=normKey(v);
  const aliases={
    'mgr':'Manager','manager':'Manager',
    'sr mgr':'Senior Manager','sr manager':'Senior Manager','senior mgr':'Senior Manager','senior manager':'Senior Manager',
    'dy mgr':'Deputy Manager','deputy mgr':'Deputy Manager','deputy manager':'Deputy Manager',
    'asst mgr':'Assistant Manager','ast mgr':'Assistant Manager','assistant manager':'Assistant Manager',
    'jr mgr':'Junior Manager','junior manager':'Junior Manager',
    'mt':'Management Trainee','management trainee':'Management Trainee',
    'agm':'Assistant General Manager','asst general manager':'Assistant General Manager','assistant general manager':'Assistant General Manager',
    'dgm':'Deputy General Manager','deputy general manager':'Deputy General Manager',
    'gm':'General Manager','general manager':'General Manager',
    'cgm':'Chief General Manager','chief general manager':'Chief General Manager',
    'ed':'Executive Director','executive director':'Executive Director','cmd':'CMD',
    'tech':'Technician','technician':'Technician','kalasi':'Kalasi',
    'chgman':'Chargeman','chargeman':'Chargeman',
    'fm':'Foreman','foreman':'Foreman','afm':'Acting Foreman','acting foreman':'Acting Foreman',
    'gf':'General Foreman','general foreman':'General Foreman'
  };
  return aliases[k]||String(v||'').trim().replace(/\b\w/g,c=>c.toUpperCase());
}
const EMPLOYEE_HIERARCHY_V850={
 CONTRACT_WORKER:[['UNSKILLED','Unskilled'],['HELPER','Helper'],['SEMI_SKILLED','Semi-Skilled'],['SKILLED','Skilled'],['FITTER','Fitter'],['WELDER','Welder'],['RIGGER','Rigger'],['SUPERVISOR','Supervisor']],
 NON_EXECUTIVE:[['KALASI','Kalasi'],['TECHNICIAN','Technician'],['CHARGEMAN','Chargeman'],['FOREMAN','Foreman'],['ACTING_FOREMAN','Acting Foreman'],['GENERAL_FOREMAN','General Foreman']],
 EXECUTIVE:[['MANAGEMENT_TRAINEE','Management Trainee'],['JUNIOR_MANAGER','Junior Manager'],['ASSISTANT_MANAGER','Assistant Manager'],['DEPUTY_MANAGER','Deputy Manager'],['MANAGER','Manager'],['SENIOR_MANAGER','Senior Manager'],['ASSISTANT_GENERAL_MANAGER','Assistant General Manager'],['DEPUTY_GENERAL_MANAGER','Deputy General Manager'],['GENERAL_MANAGER','General Manager'],['CHIEF_GENERAL_MANAGER','Chief General Manager'],['EXECUTIVE_DIRECTOR','Executive Director'],['CMD','CMD']]
};
const OPERATIONAL_RESPONSIBILITIES_V850=[['NORMAL_EMPLOYEE','Normal Employee'],['SHIFT_INCHARGE','Shift In-charge'],['AREA_INCHARGE','Area In-charge'],['SECTION_INCHARGE','Section In-charge'],['HOD','HOD'],['DGM','DGM'],['SUPER_ADMIN','Super Admin']];
function employeeBandV83(designation=''){
  const d=canonicalDesignationV83(designation);
  if(['Kalasi','Technician','Chargeman','Foreman','Acting Foreman','General Foreman'].includes(d)) return 'NON_EXECUTIVE';
  if(d==='Deputy General Manager') return 'DGM';
  if(['Management Trainee','Junior Manager','Assistant Manager','Deputy Manager','Manager','Senior Manager','Assistant General Manager'].includes(d)) return 'EXECUTIVE';
  if(['General Manager','Chief General Manager','Executive Director','CMD'].includes(d)) return 'SENIOR_EXECUTIVE';
  return 'UNCLASSIFIED';
}
const ACCESS_AUTH_V858={
  ENTRY:['ENTRY'],
  VIEW_ONLY:['VIEW'],
  ENTRY_VIEW:['ENTRY','VIEW'],
  EDIT:['ENTRY','VIEW','EDIT'],
  FULL_ACCESS:['ENTRY','VIEW','EDIT','DELETE_UNDO','APPROVAL','PDF','PRINT_EXPORT','EXCEL','ANALYSIS','REPORTS','ADVANCED_REPORTS','RCM']
};
const ALL_USER_AUTHORITIES_V858=['ENTRY','VIEW','EDIT','DELETE_UNDO','APPROVAL','PDF','PRINT_EXPORT','EXCEL','ANALYSIS','REPORTS','ADVANCED_REPORTS','RCM'];
function sameAuthV860(a,b){
 const A=[...new Set(a||[])].sort(),B=[...new Set(b||[])].sort();
 return A.length===B.length&&A.every((x,i)=>x===B[i]);
}
function accessFromAuthoritiesV858(auth=[]){
 for(const [level,set] of Object.entries(ACCESS_AUTH_V858))if(sameAuthV860(auth,set))return level;
 return (auth||[]).length?'CUSTOM':'NONE';
}
async function setAccessSyncedV858(emp,access,by){
 const auth=ACCESS_AUTH_V858[access]; if(!auth)throw new Error('Invalid access');
 const u=await byEmp(emp);if(!u)throw new Error('Employee not found');
 await ensureProfile(u,by);
 const o=await saveAdminOverrideV850(emp,{access_level:access,authorities:[...auth]},by);
 await applyAdminOverrideV850(u,o,by);
}
async function toggleAuthoritySyncedV858(emp,val,by){
 const u=await byEmp(emp);if(!u)throw new Error('Employee not found');await ensureProfile(u,by);
 const r=await pool.query('SELECT authorities FROM user_access_profile WHERE employee_number=$1',[emp]);
 const a=new Set(r.rows[0]?.authorities||[]);a.has(val)?a.delete(val):a.add(val);
 // dependencies: EDIT needs ENTRY+VIEW; advanced capabilities imply VIEW
 if(a.has('EDIT')){a.add('ENTRY');a.add('VIEW');}
 if(['PDF','PRINT_EXPORT','EXCEL','ANALYSIS','REPORTS','ADVANCED_REPORTS','RCM','DELETE_UNDO','APPROVAL'].some(x=>a.has(x)))a.add('VIEW');
 const auth=[...a],access=accessFromAuthoritiesV858(auth);
 const o=await saveAdminOverrideV850(emp,{access_level:access,authorities:auth},by);
 await applyAdminOverrideV850(u,o,by);
 return access;
}
function autoAuthorityV83(u){
  const band=employeeBandV83(u.designation);
  if(band==='NON_EXECUTIVE') return {role:'NON_EXECUTIVE',access:'ENTRY',authorities:['ENTRY'],scope:'REGISTERED_AREA_SECTION'};
  if(band==='EXECUTIVE') return {role:'EXECUTIVE',access:'ENTRY_VIEW',authorities:['ENTRY','VIEW'],scope:'REGISTERED_AREA_SECTION'};
  if(band==='DGM'||band==='SENIOR_EXECUTIVE') return {role:band==='DGM'?'DGM':'EXECUTIVE',access:'FULL_ACCESS',authorities:[...ACCESS_AUTH_V858.FULL_ACCESS],scope:'ASSIGNED_SECTION'};
  return {role:'NORMAL_USER',access:'RELEVANT_MODULE_ENTRY',authorities:['ENTRY'],scope:'REGISTERED_AREA_SECTION'};
}
function workResponsibilityV83(u){
  const area=canonicalArea(u.area_of_working), sec=canonicalSection(u.section_department), sh=canonicalShift(u.shift);
  let duties=[];
  if(sec==='HOD') return 'LMMM Department Head';
  if(sec==='Mechanical') duties=[`${area} equipment maintenance`,`${area} equipment availability`,'Support uninterrupted production'];
  else if(sec==='Operations') duties=[`${area} operation`,'Production continuity','Production/delay/log-book entries'];
  else if(sec==='Electrical') duties=[`${area} electrical equipment maintenance`,'Electrical equipment availability','Support uninterrupted production'];
  else if(sec==='Instrumentation') duties=[`${area} instrumentation maintenance`,'Instrumentation availability','Support uninterrupted production'];
  else duties=[`${area} ${sec} responsibilities`];
  if(sh==='General') duties.push('General Shift coordination');
  else if(['A','B','C'].includes(sh)) duties.push(`${sh} Shift duty coverage`);
  else if(sh==='ROTATING_ABC') duties.push('Rotating A/B/C shift duty coverage');
  return duties.join('; ');
}
function profileLooksStaleV841(u,p){
  if(!p) return false;
  const area=canonicalArea(u.area_of_working), resp=String(p.responsibility||'').toUpperCase();
  if(LMMM_ORG.areas.filter(x=>x!==area).some(x=>resp.includes(x))) return true;
  if(canonicalShift(u.shift)==='ROTATING_ABC' && String(p.assigned_role||'')==='SHIFT_INCHARGE') return true;
  return false;
}
function canonicalShift(v=''){
  const raw=String(v||'').trim(); if(!raw) return null;
  const k=raw.toLowerCase().replace(/[\s._-]+/g,'');
  if(['a','ashift','1','first'].includes(k)) return 'A';
  if(['b','bshift','2','second'].includes(k)) return 'B';
  if(['c','cshift','3','third','night','nightshift'].includes(k)) return 'C';
  if(['g','gs','gshift','gen','genrl','generl','general','generalshift','generalshft'].includes(k)) return 'General';
  if(['shift','shifts','abc','abcshift','abcshifts','rotating','rotatingshift','rotatingshifts'].includes(k)) return 'ROTATING_ABC';
  return raw;
}
const SHIFT_TIMINGS={
  A:{start:'06:00',end:'14:30'},
  B:{start:'14:00',end:'22:30'},
  C:{start:'22:00',end:'06:30'},
  General:{start:'09:00',end:'17:30'},
  ROTATING_ABC:{start:'A/B/C',end:'Rotating roster'}
};

function roleFromDesignation(desig){
  const d=String(desig||'').toLowerCase();
  if(/chief general manager|executive director|\bcmd\b|general manager|deputy general manager/.test(d)) return 'FULL_ACCESS';
  if(/assistant general manager|senior manager|manager|deputy manager|assistant manager|junior manager|management trainee/.test(d)) return 'EXECUTIVE_ENTRY_VIEW';
  return 'RELEVANT_MODULE_ENTRY';
}
function registrationTemplate(prefix='Please register'){
  return `${prefix}\n\nName:\nEmployee No:\nDesignation:\nArea:\nSection:\nShift:\n\nName and Employee No are compulsory.`;
}
function parseRegistration(text=''){
  const lines=String(text).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const d={};
  let labelled=0;
  for(const line of lines){
    const m=line.match(/^(name|employee\s*(?:no|number)?|emp\s*(?:no|number)?|designation|desgn|desig|area|section|dept|department|shift)\s*[:=-]\s*(.*)$/i);
    if(!m) continue;
    labelled++;
    const key=m[1].toLowerCase(), val=m[2].trim();
    if(key==='name') d.name=val;
    else if(key.startsWith('employee')||key.startsWith('emp')) d.employee_number=val;
    else if(key.startsWith('des')) d.designation=val;
    else if(key==='area') d.area=val;
    else if(['section','dept','department'].includes(key)) d.section=val;
    else if(key==='shift') d.shift=val;
  }

  // WhatsApp-friendly positional form:
  // Name
  // Employee No
  // Designation
  // Area
  // Section
  // Shift
  // This is the exact order shown by the registration prompt.
  if(labelled===0 && lines.length>=2){
    d.name=lines[0];
    d.employee_number=lines[1];
    d.designation=lines[2] || '';
    d.area=lines[3] || '';
    d.section=lines[4] || '';
    d.shift=lines[5] || '';
  }

  if(!d.name || !/^\d+$/.test(String(d.employee_number||''))) return null;
  return {
    name:d.name.trim(),
    employee_number:String(d.employee_number).trim(),
    designation:canonicalDesignationV83(d.designation),
    area:canonicalArea(d.area),
    section:canonicalSection(d.section),
    shift:canonicalShift(d.shift)
  };
}
async function sendText(to, body){
  if(!PHONE_NUMBER_ID || !ACCESS_TOKEN) throw new Error('Meta WhatsApp credentials missing');
  const r=await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,{
    method:'POST',headers:{Authorization:`Bearer ${ACCESS_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify({messaging_product:'whatsapp',to,type:'text',text:{body:String(body).slice(0,4096)}})
  });
  if(!r.ok) throw new Error(`WhatsApp send failed ${r.status}: ${await r.text()}`);
}

async function sendButtons(to, body, buttons){
  if(!PHONE_NUMBER_ID || !ACCESS_TOKEN) throw new Error('Meta WhatsApp credentials missing');
  const btns=(buttons||[]).slice(0,3).map(b=>({type:'reply',reply:{id:String(b.id).slice(0,256),title:String(b.title).slice(0,20)}}));
  const r=await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,{
    method:'POST',headers:{Authorization:`Bearer ${ACCESS_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify({messaging_product:'whatsapp',to,type:'interactive',interactive:{type:'button',body:{text:String(body).slice(0,1024)},action:{buttons:btns}}})
  });
  if(!r.ok) throw new Error(`WhatsApp button send failed ${r.status}: ${await r.text()}`);
}
async function sendList(to, body, buttonText, rows, sectionTitle='Options'){
  if(!PHONE_NUMBER_ID || !ACCESS_TOKEN) throw new Error('Meta WhatsApp credentials missing');
  const clean=(rows||[]).slice(0,10).map((r,i)=>({
    id:String(r.id||`ROW_${i+1}`).slice(0,200),
    title:String(r.title||`Option ${i+1}`).slice(0,24),
    ...(r.description?{description:String(r.description).slice(0,72)}:{})
  }));
  if(!clean.length){await sendText(to,'No options available.');return;}
  const payload={messaging_product:'whatsapp',to,type:'interactive',interactive:{
    type:'list',body:{text:String(body||'Select an option').slice(0,1024)},
    action:{button:String(buttonText||'Select').slice(0,20),sections:[{title:String(sectionTitle||'Options').slice(0,24),rows:clean}]}
  }};
  const r=await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,{
    method:'POST',headers:{Authorization:`Bearer ${ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(payload)
  });
  if(!r.ok) throw new Error(`WhatsApp list send failed ${r.status}: ${await r.text()}`);
}


async function sendGeneratedDocumentV878(to, bytes, filename, mime='text/plain'){
  if(!PHONE_NUMBER_ID || !ACCESS_TOKEN) throw new Error('Meta WhatsApp credentials missing');
  const fd=new FormData();
  fd.append('messaging_product','whatsapp');
  fd.append('file',new Blob([bytes],{type:mime}),filename);
  const up=await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/media`,{
    method:'POST',headers:{Authorization:`Bearer ${ACCESS_TOKEN}`},body:fd
  });
  if(!up.ok) throw new Error(`WhatsApp media upload failed ${up.status}: ${await up.text()}`);
  const uj=await up.json(); if(!uj.id) throw new Error('WhatsApp media upload returned no id');
  const r=await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,{
    method:'POST',headers:{Authorization:`Bearer ${ACCESS_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify({messaging_product:'whatsapp',to,type:'document',document:{id:uj.id,filename}})
  });
  if(!r.ok) throw new Error(`WhatsApp document send failed ${r.status}: ${await r.text()}`);
}

async function initDB(){
  if(!pool) throw new Error('DATABASE_URL missing');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id BIGSERIAL PRIMARY KEY,
      whatsapp_number TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      employee_number TEXT UNIQUE NOT NULL,
      designation TEXT,
      area_of_working TEXT,
      section_department TEXT,
      shift TEXT,
      approval_status TEXT NOT NULL DEFAULT 'pending',
      is_active BOOLEAN NOT NULL DEFAULT false,
      operational_role TEXT NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS registration_audit(
      id BIGSERIAL PRIMARY KEY,
      employee_number TEXT,
      whatsapp_number TEXT,
      action TEXT NOT NULL,
      performed_by TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS user_access_profile(
      employee_number TEXT PRIMARY KEY, assigned_role TEXT, access_level TEXT,
      responsibility TEXT, authorities TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
      assignment_source TEXT NOT NULL DEFAULT 'AUTO', assigned_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ui_sessions(
      whatsapp_number TEXT NOT NULL,
      session_key TEXT NOT NULL,
      session_value JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(whatsapp_number,session_key)
    );
    CREATE TABLE IF NOT EXISTS employee_contact_directory(
      employee_number TEXT PRIMARY KEY,
      whatsapp_registration_number TEXT NOT NULL,
      alternate_phone_number TEXT,
      company_email TEXT,
      personal_email TEXT,
      max_number TEXT,
      emergency_contact_name TEXT,
      emergency_contact_phone TEXT,
      office_extension TEXT,
      notes TEXT,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS user_admin_override(
      employee_number TEXT PRIMARY KEY,
      category TEXT, designation TEXT, area TEXT, section TEXT, shift TEXT,
      operational_role TEXT, access_level TEXT, responsibility TEXT,
      authorities TEXT[] NOT NULL DEFAULT ARRAY[]::text[], scope TEXT,
      updated_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS employee_roster(
      id BIGSERIAL PRIMARY KEY, employee_number TEXT NOT NULL,
      duty_date DATE NOT NULL, duty_type TEXT NOT NULL,
      shift TEXT, source TEXT NOT NULL DEFAULT 'ENTRY',
      entered_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(employee_number,duty_date)
    );
    CREATE TABLE IF NOT EXISTS system_migrations(
      migration_key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS maintenance_ingest_records(
      id BIGSERIAL PRIMARY KEY,
      data_class TEXT NOT NULL DEFAULT 'TEST',
      source_type TEXT NOT NULL DEFAULT 'WHATSAPP_FILE',
      source_media_id TEXT, source_filename TEXT, source_mime_type TEXT,
      source_caption TEXT, source_sha256 TEXT,
      submitted_by_employee_number TEXT, submitted_by_whatsapp TEXT NOT NULL,
      module TEXT NOT NULL DEFAULT 'NEEDS_REVIEW', area TEXT, equipment TEXT, sub_equipment TEXT,
      event_date DATE, event_time TIME, shift TEXT, description TEXT, action_taken TEXT, status TEXT, remarks TEXT,
      confidence TEXT NOT NULL DEFAULT 'NEEDS_REVIEW', raw_extraction JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ingest_equipment ON maintenance_ingest_records(equipment);
    CREATE INDEX IF NOT EXISTS idx_ingest_module_date ON maintenance_ingest_records(module,event_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_source_fingerprint ON maintenance_ingest_records(submitted_by_whatsapp,source_sha256,module,COALESCE(event_date,'1900-01-01'::date),COALESCE(equipment,''),COALESCE(description,''));
    CREATE TABLE IF NOT EXISTS pending_file_ingests(
      id BIGSERIAL PRIMARY KEY, submitted_by_whatsapp TEXT NOT NULL, submitted_by_employee_number TEXT,
      source_media_id TEXT, source_filename TEXT, source_mime_type TEXT, source_caption TEXT, source_sha256 TEXT,
      extracted_rows JSONB NOT NULL DEFAULT '[]'::jsonb, status TEXT NOT NULL DEFAULT 'PENDING_CONFIRMATION',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_pending_ingest_user ON pending_file_ingests(submitted_by_whatsapp,status,created_at);
  `);
  await pool.query(`ALTER TABLE pending_file_ingests ADD COLUMN IF NOT EXISTS source_bytes BYTEA`);
  await pool.query(`ALTER TABLE pending_file_ingests ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE pending_file_ingests ADD COLUMN IF NOT EXISTS last_error TEXT`);
  await pool.query(`ALTER TABLE pending_file_ingests ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE pending_file_ingests ADD COLUMN IF NOT EXISTS extraction_engine_version TEXT`);
  await pool.query(`ALTER TABLE pending_file_ingests ADD COLUMN IF NOT EXISTS workflow_state TEXT NOT NULL DEFAULT 'RECEIVED'`);
  await pool.query(`ALTER TABLE pending_file_ingests ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE pending_file_ingests ADD COLUMN IF NOT EXISTS last_provider TEXT`);
  await pool.query(`ALTER TABLE pending_file_ingests ADD COLUMN IF NOT EXISTS delivery_pending BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE pending_file_ingests ADD COLUMN IF NOT EXISTS archive_sync_status TEXT NOT NULL DEFAULT 'PENDING'`);
  await pool.query(`ALTER TABLE pending_file_ingests ADD COLUMN IF NOT EXISTS archive_file_id TEXT`);

  await pool.query(`ALTER TABLE pending_file_ingests ADD COLUMN IF NOT EXISTS confirmation_expires_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE pending_file_ingests ADD COLUMN IF NOT EXISTS source_purged_at TIMESTAMPTZ`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reliability_events(
    id BIGSERIAL PRIMARY KEY,
    ingest_id BIGINT,
    whatsapp TEXT,
    stage TEXT NOT NULL,
    state TEXT NOT NULL,
    provider TEXT,
    error_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reliability_ingest ON reliability_events(ingest_id,created_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS whatsapp_message_dedupe(
    message_id TEXT PRIMARY KEY, whatsapp TEXT, message_type TEXT, received_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_wa_dedupe_received ON whatsapp_message_dedupe(received_at)`);
  await pool.query(`DELETE FROM whatsapp_message_dedupe WHERE received_at < now()-interval '7 days'`).catch(()=>{});

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pending_ingest_retry ON pending_file_ingests(status,next_retry_at,created_at)`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_category TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_type TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reporting_to_employee_number TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS location TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS remarks TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ DEFAULT now()`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS data_class TEXT NOT NULL DEFAULT 'TESTER'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_data_class ON users(data_class)`);
  await pool.query(`ALTER TABLE users ALTER COLUMN data_class SET DEFAULT 'TESTER'`);
  // V8.7.3 TESTING MODE: every non-Super-Admin registration is TESTER.
  const _testAdmins=[...SUPER_ADMINS];
  if(_testAdmins.length){await pool.query(`UPDATE users SET data_class='TESTER',updated_at=now() WHERE NOT (whatsapp_number = ANY($1::text[]))`,[_testAdmins]);}
  else {await pool.query(`UPDATE users SET data_class='TESTER',updated_at=now()`);}
  // User explicitly requested a clean user reset. Run exactly once.
  const key='V8_0_1_RESET_NON_SUPERADMIN_REGISTRATIONS_2026_09_22';
  const done=await pool.query('SELECT 1 FROM system_migrations WHERE migration_key=$1',[key]);
  if(!done.rowCount){
    await pool.query('BEGIN');
    try{
      // Only registration/auth state is reset. Maintenance/history/master data tables are untouched.
      for(const t of ['ui_selection_sessions','pending_search_choices','search_context','user_default_permissions','user_special_permissions','user_responsibilities','user_assignments']){
        await pool.query(`DELETE FROM ${t}`).catch(()=>{});
      }
      // Preserve configured Super Admin account(s); reset every other registration.
      // If a Super Admin row already exists, keep it active and force FULL_ACCESS.
      const admins=[...SUPER_ADMINS];
      if(admins.length){
        await pool.query(`DELETE FROM users WHERE NOT (regexp_replace(whatsapp_number,'\\D','','g') = ANY($1::text[]))`,[admins]);
        await pool.query(`UPDATE users SET approval_status='approved',is_active=true,operational_role='FULL_ACCESS',updated_at=now()
                          WHERE regexp_replace(whatsapp_number,'\\D','','g') = ANY($1::text[])`,[admins]);
      } else {
        throw new Error('SUPER_ADMIN_NUMBER(S) must be configured before clean reset; refusing to remove users without preserving Super Admin.');
      }
      await pool.query('INSERT INTO system_migrations(migration_key) VALUES($1)',[key]);
      await pool.query('COMMIT');
      console.log('[V8.0.1] one-time non-Super-Admin registration reset complete; Super Admin preserved');
    }catch(e){await pool.query('ROLLBACK');throw e;}
  }
}
async function byWA(wa){ const r=await pool.query('SELECT * FROM users WHERE whatsapp_number=$1 LIMIT 1',[normWA(wa)]); return r.rows[0]||null; }
async function byEmp(emp){ const r=await pool.query('SELECT * FROM users WHERE employee_number=$1 LIMIT 1',[String(emp)]); return r.rows[0]||null; }
async function audit(u,action,by,details={}){
  await pool.query('INSERT INTO registration_audit(employee_number,whatsapp_number,action,performed_by,details) VALUES($1,$2,$3,$4,$5::jsonb)',[u?.employee_number||null,u?.whatsapp_number||null,action,String(by||''),JSON.stringify(details)]);
}
async function saveRegistration(from,d){
  const wa=normWA(from);
  const conflict=await byEmp(d.employee_number);
  if(conflict && conflict.whatsapp_number!==wa && conflict.approval_status==='approved' && conflict.is_active) return {ok:false,reason:'EMPLOYEE_ACTIVE'};
  await pool.query('BEGIN');
  try{
    await pool.query('DELETE FROM users WHERE whatsapp_number=$1 OR employee_number=$2',[wa,d.employee_number]);
    const r=await pool.query(`INSERT INTO users(whatsapp_number,name,employee_number,designation,area_of_working,section_department,shift,approval_status,is_active,operational_role,data_class)
      VALUES($1,$2,$3,$4,$5,$6,$7,'pending',false,'PENDING','TESTER') RETURNING *`,
      [wa,d.name,d.employee_number,d.designation,d.area,d.section,d.shift]);
    await audit(r.rows[0],'REGISTER_PENDING',wa,{canonicalized:true});
    await pool.query('COMMIT'); return {ok:true,user:r.rows[0]};
  }catch(e){await pool.query('ROLLBACK');throw e;}
}
async function removeRegistration(u,by){
  await pool.query('BEGIN');
  try{
    await audit(u,'REMOVE_REGISTRATION',by,{maintenance_history_preserved:true,reregister_allowed:true});
    await pool.query('DELETE FROM users WHERE employee_number=$1',[u.employee_number]);
    await pool.query('COMMIT');
  }catch(e){await pool.query('ROLLBACK');throw e;}
}

async function syncPrimaryContactV851(u,by='SYSTEM'){
  if(!u?.employee_number||!u?.whatsapp_number)return;
  await pool.query(`INSERT INTO employee_contact_directory(employee_number,whatsapp_registration_number,updated_by,updated_at)
    VALUES($1,$2,$3,now())
    ON CONFLICT(employee_number) DO UPDATE SET whatsapp_registration_number=EXCLUDED.whatsapp_registration_number,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [u.employee_number,normWA(u.whatsapp_number),by]);
}
function cleanPhoneV851(v=''){const x=String(v||'').replace(/[^\d+]/g,'');return x.length>=7?x:null;}
function cleanEmailV851(v=''){const x=String(v||'').trim().toLowerCase();return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)?x:null;}
async function contactCardV851(emp){
 const r=await pool.query(`SELECT u.name,u.employee_number,u.designation,u.area_of_working,u.section_department,
 c.whatsapp_registration_number,c.alternate_phone_number,c.company_email,c.personal_email,c.max_number,c.emergency_contact_name,c.emergency_contact_phone,c.office_extension,c.notes
 FROM users u LEFT JOIN employee_contact_directory c ON c.employee_number=u.employee_number WHERE u.employee_number=$1 LIMIT 1`,[emp]);
 return r.rows[0]||null;
}
async function sendContactAdminV851(to,emp){
 const c=await contactCardV851(emp); if(!c){await sendText(to,'Employee not found.');return;}
 const u=await byEmp(emp),p=u?(await pool.query('SELECT * FROM user_access_profile WHERE employee_number=$1',[emp])).rows[0]:null,o=u?await adminOverrideV850(emp):null,g=u?governanceScopeV870(u,p,o):null;
 await sendText(to,`Employee & Contact Details

Name: ${c.name}
Employee No: ${c.employee_number}
Designation: ${c.designation||'-'}
Department: LMMM / 35
Destination / Assigned Area: ${u?.area_of_working||'-'}
Section: ${u?.section_department||'-'}
Shift: ${u?.shift||'-'}
Role: ${p?.assigned_role||'-'}
Scope: ${g?.label||'-'}
Responsibility: ${g?.responsibility||p?.responsibility||'-'}

WhatsApp / Main Phone: ${c.whatsapp_registration_number||'-'}
Alternate Phone: ${c.alternate_phone_number||'-'}
Company Email: ${c.company_email||'-'}
Personal Email: ${c.personal_email||'-'}
MAX Number: ${c.max_number||'-'}
Office Extension: ${c.office_extension||'-'}
Emergency Contact: ${c.emergency_contact_name||'-'}
Emergency Phone: ${c.emergency_contact_phone||'-'}
Notes: ${c.notes||'-'}`);
}

async function sendMyContactV852(to,u){
  await syncPrimaryContactV851(u,normWA(to));
  const c=await contactCardV851(u.employee_number);
  if(!c){await sendText(to,'Contact details not available.');return;}
  const missing=[];
  if(!c.alternate_phone_number)missing.push({id:'MYC_ALT',title:'Add Alternate Phone'});
  if(!c.company_email)missing.push({id:'MYC_CMAIL',title:'Add Company Email'});
  if(!c.personal_email)missing.push({id:'MYC_PMAIL',title:'Add Personal Email'});
  if(!c.max_number)missing.push({id:'MYC_MAX',title:'Add MAX Number'});
  if(!c.office_extension)missing.push({id:'MYC_EXT',title:'Add Office Extension'});
  if(!c.emergency_contact_phone)missing.push({id:'MYC_EMER',title:'Add Emergency Contact'});
  const body=`My Contact Details

WhatsApp / Main Phone: ${c.whatsapp_registration_number||'-'}
Alternate Phone: ${c.alternate_phone_number||'-'}
Company Email: ${c.company_email||'-'}
Personal Email: ${c.personal_email||'-'}
MAX Number: ${c.max_number||'-'}
Office Extension: ${c.office_extension||'-'}
Emergency Contact: ${c.emergency_contact_name||'-'}
Emergency Phone: ${c.emergency_contact_phone||'-'}`;
  await sendText(to,body);
  if(missing.length)await sendList(to,'Missing Contact Details','Add',missing,'Add missing details');
  else await sendButtons(to,'Contact details complete',[{id:'MYC_EDIT',title:'Edit Contact Details'}]);
}
function extractContactFieldsV852(text=''){
  const raw=String(text||'').trim(), out={};
  const emails=[...raw.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map(x=>x[0].toLowerCase());
  for(const e of emails){
    if(/(vsp|rinl|vizagsteel|steel)/i.test(e) && !out.company_email)out.company_email=e;
    else if(!out.personal_email)out.personal_email=e;
  }
  const get=(re)=>{const m=raw.match(re);return m?.[1]?.trim()||null;};
  const alt=get(/(?:alternate|alt|other|second)\s*(?:phone|mobile|number|no)?\s*[:=-]?\s*(\+?\d[\d\s-]{6,})/i);
  const max=get(/\bmax\s*(?:number|no)?\s*[:=-]?\s*([A-Z0-9-]+)/i);
  const ext=get(/(?:office\s*)?(?:extension|ext)\s*[:=-]?\s*([A-Z0-9-]+)/i);
  const emer=get(/emergency\s*(?:contact)?\s*[:=-]?\s*([^,\n]+)[,\s]+(\+?\d[\d\s-]{6,})/i);
  if(alt)out.alternate_phone_number=cleanPhoneV851(alt);
  if(max)out.max_number=max;
  if(ext)out.office_extension=ext;
  if(emer){out.emergency_contact_name=emer[1].trim();out.emergency_contact_phone=cleanPhoneV851(emer[2]);}
  return Object.fromEntries(Object.entries(out).filter(([,v])=>v));
}
async function saveOwnContactPatchV852(u,patch){
  await syncPrimaryContactV851(u,u.employee_number);
  const allowed=['alternate_phone_number','company_email','personal_email','max_number','office_extension','emergency_contact_name','emergency_contact_phone'];
  for(const [k,v] of Object.entries(patch))if(allowed.includes(k))await pool.query(`UPDATE employee_contact_directory SET ${k}=$2,updated_by=$3,updated_at=now() WHERE employee_number=$1`,[u.employee_number,v,u.employee_number]);
}
async function setDataClassV854(emp,kind,by){
 kind=String(kind||'').toUpperCase(); if(!['MAIN','TESTER'].includes(kind))throw new Error('Invalid data class');
 const u=await byEmp(emp);if(!u)throw new Error('Employee not found');
 if(isOwner(u.whatsapp_number)&&kind==='TESTER')throw new Error('Super Admin cannot be marked as TESTER');
 await pool.query('UPDATE users SET data_class=$2,updated_at=now() WHERE employee_number=$1',[emp,kind]);
 await pool.query(`INSERT INTO registration_audit(employee_number,whatsapp_number,action,performed_by,details) VALUES($1,$2,'DATA_CLASS_CHANGED',$3,$4)`,
 [emp,u.whatsapp_number,by,JSON.stringify({data_class:kind})]); return kind;
}
async function purgeTesterUsersV854(by){
 const rr=await pool.query(`SELECT employee_number,whatsapp_number FROM users WHERE data_class='TESTER'`);let removed=0;
 for(const u of rr.rows){if(isOwner(u.whatsapp_number))continue;
  await pool.query('DELETE FROM ui_sessions WHERE whatsapp_number=$1',[normWA(u.whatsapp_number)]);
  await pool.query('DELETE FROM employee_contact_directory WHERE employee_number=$1',[u.employee_number]);
  await pool.query('DELETE FROM user_admin_override WHERE employee_number=$1',[u.employee_number]);
  await pool.query('DELETE FROM user_access_profile WHERE employee_number=$1',[u.employee_number]);
  await pool.query('DELETE FROM employee_roster WHERE employee_number=$1',[u.employee_number]);
  await pool.query('DELETE FROM users WHERE employee_number=$1',[u.employee_number]);removed++;
 } return removed;
}
async function safeSessionV855(wa,key){
 try{return (await pool.query('SELECT session_value FROM ui_sessions WHERE whatsapp_number=$1 AND session_key=$2',[normWA(wa),key])).rows[0]||null;}
 catch(e){console.error('[SESSION_READ]',e.message);return null;}
}
async function adminOverrideV850(emp){return (await pool.query('SELECT * FROM user_admin_override WHERE employee_number=$1',[emp])).rows[0]||null;}
async function saveAdminOverrideV850(emp,patch,by){
 const old=await adminOverrideV850(emp), n={...(old||{}),...patch};
 await pool.query(`INSERT INTO user_admin_override(employee_number,category,designation,area,section,shift,operational_role,access_level,responsibility,authorities,scope,updated_by,updated_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
 ON CONFLICT(employee_number) DO UPDATE SET category=EXCLUDED.category,designation=EXCLUDED.designation,area=EXCLUDED.area,section=EXCLUDED.section,shift=EXCLUDED.shift,
 operational_role=EXCLUDED.operational_role,access_level=EXCLUDED.access_level,responsibility=EXCLUDED.responsibility,authorities=EXCLUDED.authorities,scope=EXCLUDED.scope,updated_by=EXCLUDED.updated_by,updated_at=now()`,
 [emp,n.category||null,n.designation||null,n.area||null,n.section||null,n.shift||null,n.operational_role||null,n.access_level||null,n.responsibility||null,n.authorities||[],n.scope||null,by]); return n;
}
function categoryDefaultAccessV850(cat,d=''){
 if(cat==='CONTRACT_WORKER'||cat==='NON_EXECUTIVE')return {role:cat,access:'ENTRY'};
 if(canonicalDesignationV83(d)==='Deputy General Manager')return {role:'DGM',access:'FULL_ACCESS'};
 return {role:'EXECUTIVE',access:'ENTRY_VIEW'};
}
async function applyAdminOverrideV850(u,o,by){
 if(!o)return;
 const designation=o.designation||u.designation,area=o.area||u.area_of_working,section=o.section||u.section_department,shift=o.shift||u.shift;
 await pool.query(`UPDATE users SET designation=$2,area_of_working=$3,section_department=$4,shift=$5,updated_at=now() WHERE employee_number=$1`,[u.employee_number,designation,area,section,shift]);
 const fresh={...u,designation,area_of_working:area,section_department:section,shift}, auto=autoAuthorityV83(fresh);
 const role=o.operational_role||auto.role,resp=o.responsibility||workResponsibilityV83(fresh);
 let auth=Array.isArray(o.authorities)?o.authorities:auto.authorities;
 let access=o.access_level||accessFromAuthoritiesV858(auth)||auto.access;
 if(ACCESS_AUTH_V858[access] && !sameAuthV860(auth,ACCESS_AUTH_V858[access])) auth=[...ACCESS_AUTH_V858[access]];
 else if(!ACCESS_AUTH_V858[access]) access=accessFromAuthoritiesV858(auth);
 await pool.query(`INSERT INTO user_access_profile(employee_number,assigned_role,access_level,responsibility,authorities,assignment_source,assigned_by)
 VALUES($1,$2,$3,$4,$5,'SUPER_ADMIN',$6) ON CONFLICT(employee_number) DO UPDATE SET assigned_role=EXCLUDED.assigned_role,access_level=EXCLUDED.access_level,
 responsibility=EXCLUDED.responsibility,authorities=EXCLUDED.authorities,assignment_source='SUPER_ADMIN',assigned_by=EXCLUDED.assigned_by,updated_at=now()`,
 [u.employee_number,role,access,resp,auth,by]);
}
async function ensureProfile(u,by='SYSTEM'){
  await syncPrimaryContactV851(u,by);
  const explicit=await adminOverrideV850(u.employee_number); if(explicit){await applyAdminOverrideV850(u,explicit,by);return;}
  const area=canonicalArea(u.area_of_working), section=canonicalSection(u.section_department),
        designation=canonicalDesignationV83(u.designation), shift=canonicalShift(u.shift);
  if(area!==u.area_of_working || section!==u.section_department || designation!==u.designation || shift!==u.shift){
    await pool.query(`UPDATE users SET area_of_working=$2,section_department=$3,designation=$4,shift=$5,updated_at=now() WHERE employee_number=$1`,
      [u.employee_number,area,section,designation,shift]);
    u={...u,area_of_working:area,section_department:section,designation,shift};
  }
  const auto=autoAuthorityV83(u), resp=workResponsibilityV83(u);
  const old=(await pool.query('SELECT * FROM user_access_profile WHERE employee_number=$1',[u.employee_number])).rows[0];
  const stale=profileLooksStaleV841(u,old);
  await pool.query(`INSERT INTO user_access_profile(employee_number,assigned_role,access_level,responsibility,authorities,assignment_source,assigned_by)
    VALUES($1,$2,$3,$4,$5,'AUTO',$6)
    ON CONFLICT(employee_number) DO UPDATE SET
      assigned_role=CASE WHEN user_access_profile.assignment_source='SUPER_ADMIN' AND $7=false THEN user_access_profile.assigned_role ELSE EXCLUDED.assigned_role END,
      access_level=CASE WHEN user_access_profile.assignment_source='SUPER_ADMIN' AND $7=false THEN user_access_profile.access_level ELSE EXCLUDED.access_level END,
      responsibility=CASE WHEN user_access_profile.assignment_source='SUPER_ADMIN' AND $7=false THEN user_access_profile.responsibility ELSE EXCLUDED.responsibility END,
      authorities=CASE WHEN user_access_profile.assignment_source='SUPER_ADMIN' AND $7=false THEN user_access_profile.authorities ELSE EXCLUDED.authorities END,
      assignment_source=CASE WHEN user_access_profile.assignment_source='SUPER_ADMIN' AND $7=false THEN 'SUPER_ADMIN' ELSE 'AUTO' END,
      assigned_by=CASE WHEN user_access_profile.assignment_source='SUPER_ADMIN' AND $7=false THEN user_access_profile.assigned_by ELSE EXCLUDED.assigned_by END,
      updated_at=now()`,
    [u.employee_number,auto.role,auto.access,resp,auto.authorities,by,stale]);
}
async function resetProfileToAutoV841(u,by='SYSTEM'){
  await pool.query('DELETE FROM user_access_profile WHERE employee_number=$1',[u.employee_number]);
  await ensureProfile(u,by);
}
function governanceScopeV870(u,p,o){
  const role=String(p?.assigned_role||o?.operational_role||'NORMAL_EMPLOYEE').toUpperCase();
  const area=canonicalArea(o?.area||u.area_of_working)||'-';
  const section=canonicalSection(o?.section||u.section_department)||'-';
  if(role==='HOD'||section==='HOD') return {code:'LMMM_ALL',label:'LMMM',responsibility:'LMMM Department Head'};
  if(role==='SECTION_INCHARGE') return {code:'LMMM_SECTION',label:`LMMM / ${section}`,responsibility:'LMMM'};
  if(role==='AREA_INCHARGE') return {code:'AREA',label:area,responsibility:area};
  if(role==='SHIFT_INCHARGE') return {code:'SHIFT_AREA_SECTION',label:`${area} / ${section} / ${canonicalShift(o?.shift||u.shift)||'-'}`,responsibility:`${area} ${section} shift`};
  return {code:'REGISTERED_AREA_SECTION',label:`${area} / ${section}`,responsibility:p?.responsibility||workResponsibilityV83(u)};
}
async function rememberAdminEmployeeV870(to,emp){
 try{await pool.query(`INSERT INTO ui_sessions(whatsapp_number,session_key,session_value,updated_at) VALUES($1,'V870_ADMIN_EMP',$2,now()) ON CONFLICT(whatsapp_number,session_key) DO UPDATE SET session_value=EXCLUDED.session_value,updated_at=now()`,[normWA(to),JSON.stringify({employee_number:String(emp)})]);}catch(e){console.error('[ADMIN_EMP_SESSION]',e.message);}
}
async function currentAdminEmployeeV870(to){
 try{const r=await pool.query(`SELECT session_value FROM ui_sessions WHERE whatsapp_number=$1 AND session_key='V870_ADMIN_EMP'`,[normWA(to)]);return r.rows[0]?.session_value?.employee_number||null;}catch{return null;}
}
async function showUser(to,u){
  await rememberAdminEmployeeV870(to,u.employee_number);
  await ensureProfile(u,normWA(to));u=await byEmp(u.employee_number);
  await syncPrimaryContactV851(u,normWA(to));
  const p=(await pool.query('SELECT * FROM user_access_profile WHERE employee_number=$1',[u.employee_number])).rows[0];
  const c=await contactCardV851(u.employee_number),o=await adminOverrideV850(u.employee_number),g=governanceScopeV870(u,p,o);
  await sendText(to,`Employee Full Details

Name: ${u.name}
Employee No: ${u.employee_number}
Designation: ${u.designation||'-'}
Area: ${u.area_of_working||'-'}
Section: ${u.section_department||'-'}
Shift: ${u.shift||'-'}
Status: ${u.approval_status}${u.is_active?' / Active':''}
Data Class: ${u.data_class||'MAIN'}
Department: LMMM / 35
Destination / Assigned Area: ${o?.area||u.area_of_working||'-'}
Assigned Section: ${o?.section||u.section_department||'-'}
Governance Scope: ${g.label}

Main Phone: ${c?.whatsapp_registration_number||u.whatsapp_number||'-'}
Alternate Phone: ${c?.alternate_phone_number||'-'}
Company Email: ${c?.company_email||'-'}
Personal Email: ${c?.personal_email||'-'}
MAX Number: ${c?.max_number||'-'}
Office Extension: ${c?.office_extension||'-'}
Emergency Contact: ${c?.emergency_contact_name||'-'}
Emergency Phone: ${c?.emergency_contact_phone||'-'}

Category/Role: ${p?.assigned_role||'-'}
Access: ${p?.access_level||'-'}
Scope: ${g.code}
Responsibility: ${g.responsibility||p?.responsibility||'-'}
Authorities: ${(p?.authorities||[]).join(', ')||'-'}
Source: ${p?.assignment_source||'AUTO'}`);
  await sendButtons(to,'Employee Actions',[
    {id:`ADM_ASSIGN:${u.employee_number}`,title:'Assign / Change'},
    {id:`ADM_CONTACT:${u.employee_number}`,title:'Contact Details'},
    {id:`ADM_MORE:${u.employee_number}`,title:'More Options'}]);
}
async function setField(emp,col,val,by){
  const u=await byEmp(emp); if(!u)return false; await ensureProfile(u,by);
  const ok={role:'assigned_role',access:'access_level',resp:'responsibility'}[col]; if(!ok)return false;
  await pool.query(`UPDATE user_access_profile SET ${ok}=$2,assignment_source='SUPER_ADMIN',assigned_by=$3,updated_at=now() WHERE employee_number=$1`,[emp,val,by]); return true;
}
async function toggleAuth(emp,val,by){
  const u=await byEmp(emp); if(!u)return; await ensureProfile(u,by);
  const r=await pool.query('SELECT authorities FROM user_access_profile WHERE employee_number=$1',[emp]);
  const a=new Set(r.rows[0]?.authorities||[]); a.has(val)?a.delete(val):a.add(val);
  await pool.query(`UPDATE user_access_profile SET authorities=$2,assignment_source='SUPER_ADMIN',assigned_by=$3,updated_at=now() WHERE employee_number=$1`,[emp,[...a],by]);
}

async function validateRosterEntry(emp,date,dutyType,shift=null){
  const typ=String(dutyType||'').toUpperCase();
  if(!['DUTY','WEEK_OFF','LEAVE'].includes(typ)) return {ok:false,msg:'Invalid duty type.'};
  if(typ==='DUTY' && !['A','B','C','General'].includes(canonicalShift(shift))) return {ok:false,msg:'Valid shift required for duty.'};
  if(typ==='WEEK_OFF'){
    // Minimum three DUTY days must exist after the most recent WEEK_OFF or LEAVE block
    // before another WEEK_OFF can be accepted.
    const r=await pool.query(`SELECT duty_type,duty_date FROM employee_roster
      WHERE employee_number=$1 AND duty_date<$2 ORDER BY duty_date DESC LIMIT 14`,[emp,date]);
    let dutyDays=0;
    for(const x of r.rows){
      if(x.duty_type==='DUTY') dutyDays++;
      else if(x.duty_type==='WEEK_OFF' || x.duty_type==='LEAVE') break;
    }
    if(dutyDays<3) return {ok:false,msg:`Week Off not accepted: minimum 3 duty days required after previous Week Off/Leave. Duty days found: ${dutyDays}.`};
  }
  return {ok:true};
}
async function saveRosterEntry(emp,date,dutyType,shift,by){
  const sh=dutyType==='DUTY'?canonicalShift(shift):null;
  const v=await validateRosterEntry(emp,date,dutyType,sh); if(!v.ok)return v;
  await pool.query(`INSERT INTO employee_roster(employee_number,duty_date,duty_type,shift,entered_by)
    VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(employee_number,duty_date) DO UPDATE SET duty_type=EXCLUDED.duty_type,shift=EXCLUDED.shift,entered_by=EXCLUDED.entered_by`,
    [emp,date,String(dutyType).toUpperCase(),sh,by]);
  return {ok:true};
}
function governanceSelfTestV841(u,p){
  const e=autoAuthorityV83(u), t=[], add=(n,ok,d)=>t.push({n,ok,d});
  add('Designation/category',employeeBandV83(u.designation)!=='UNCLASSIFIED',`${u.designation} -> ${employeeBandV83(u.designation)}`);
  add('Area',canonicalArea(u.area_of_working)==='LMMM'||LMMM_ORG.areas.includes(canonicalArea(u.area_of_working)),canonicalArea(u.area_of_working));
  add('Section',LMMM_ORG.sections.includes(canonicalSection(u.section_department)),canonicalSection(u.section_department));
  add('Shift',['A','B','C','General','ROTATING_ABC'].includes(canonicalShift(u.shift)),canonicalShift(u.shift));
  add('Role',p?.assigned_role===e.role || p?.assignment_source==='SUPER_ADMIN',`${p?.assigned_role} / auto ${e.role}`);
  add('Access',p?.access_level===e.access || p?.assignment_source==='SUPER_ADMIN',`${p?.access_level} / auto ${e.access}`);
  add('Responsibility',!profileLooksStaleV841(u,p) && String(p?.responsibility||'').includes(canonicalArea(u.area_of_working)),p?.responsibility||'-');
  add('Authorities',Array.isArray(p?.authorities) && accessFromAuthoritiesV858(p?.authorities||[])===p?.access_level,`${(p?.authorities||[]).join(', ')||'None'} / access ${p?.access_level}`);
  return t;
}
async function sendGovernanceTestV841(to,u){
  await ensureProfile(u,normWA(to)); u=await byEmp(u.employee_number);
  const p=(await pool.query('SELECT * FROM user_access_profile WHERE employee_number=$1',[u.employee_number])).rows[0];
  const t=governanceSelfTestV841(u,p), pass=t.every(x=>x.ok);
  await sendText(to,`AUTO ASSIGN TEST • ${u.name} / ${u.employee_number}\n${t.map(x=>`${x.ok?'✅':'❌'} ${x.n}: ${x.d}`).join('\n')}\n\n${pass?'✅ AUTO ASSIGN PASS':'❌ AUTO ASSIGN NEEDS FIX'}`);
}
async function notifyAdmins(u){
  for(const a of SUPER_ADMINS){
    try{await sendButtons(a,
`New registration pending

Name: ${u.name}
Employee No: ${u.employee_number}
Designation: ${u.designation||'-'}
Area: ${u.area_of_working||'-'}
Section: ${u.section_department||'-'}
Shift: ${u.shift||'-'}`,
      [{id:`APPROVE:${u.employee_number}`,title:'Approve'},{id:`REJECT:${u.employee_number}`,title:'Reject'}]);
    }catch(e){console.error('[ADMIN NOTIFY]',e.message);}
  }
}
async function adminCommand(from,text){
  if(!SUPER_ADMINS.has(normWA(from))) return false;
  const admin=normWA(from); let a;
  // V8.7.2: survive clients/webhooks that return only interactive title, not payload ID.
  if(!/^ADM_|^AUTH_|^AU:|^SET|^SA:|^SR:/.test(text)){const emp=await currentAdminEmployeeV870(from);if(emp){const map={'User / Designation':`ADM_IDENTITY:${emp}`,'Work Assignment':`ADM_WORK:${emp}`,'Permissions':`ADM_PERM:${emp}`,'Contact Details':`ADM_CONTACT:${emp}`,'More Options':`ADM_MORE:${emp}`,'Authorities':`ADM_AUTH:${emp}`,'Core Access':`AUTH_CORE:${emp}`,'Docs / Reports':`AUTH_DOC:${emp}`,'Advanced':`AUTH_ADV:${emp}`,'Admin Tools':`ADM_ADMINTOOLS:${emp}`};if(map[text])text=map[text];}}
  if(text==='ADM_USERS'||/^users?$/i.test(text)){await sendText(from,'User Management\nSearch by Employee No or Name.');return true;}
  if((a=text.match(/^ADM_VIEW:(\d+)$/))){const u=await byEmp(a[1]); if(u)await showUser(from,u);else await sendText(from,'Employee not found.');return true;}
  if((a=text.match(/^ADM_ASSIGN:(\d+)$/))){await sendButtons(from,'Assign / Change',[
{id:`ADM_IDENTITY:${a[1]}`,title:'User / Designation'},
{id:`ADM_WORK:${a[1]}`,title:'Work Assignment'},
{id:`ADM_PERM:${a[1]}`,title:'Permissions'}]);return true;}
if((a=text.match(/^ADM_IDENTITY:(\d+)$/))){await sendList(from,'User / Designation','Select',[
{id:`ADM_CAT:${a[1]}`,title:'Category / Role'},{id:`ADM_DESIG:${a[1]}`,title:'Designation'}],'Employee Setup');return true;}
if((a=text.match(/^ADM_WORK:(\d+)$/))){await sendList(from,'Work Assignment','Select',[
{id:`ADM_AREA:${a[1]}`,title:'Destination Area'},{id:`ADM_SECTION:${a[1]}`,title:'Section'},
{id:`ADM_SHIFT:${a[1]}`,title:'Shift / Roster'},{id:`ADM_RESP:${a[1]}`,title:'Responsibility / Scope'}],'Work Assignment');return true;}
if((a=text.match(/^ADM_PERM:(\d+)$/))){await sendList(from,'Permissions','Select',[
{id:`ADM_ACCESS:${a[1]}`,title:'Access Level'},{id:`ADM_AUTH:${a[1]}`,title:'Authorities'}],'Permission Control');return true;}
if((a=text.match(/^ADM_CONTACT:(\d+)$/))){
 const emp=a[1],u=await byEmp(emp);if(u)await syncPrimaryContactV851(u,normWA(from));
 await sendContactAdminV851(from,emp);
 await sendList(from,'Edit Contact Details','Select',[
  {id:`CONTACT_ALT:${emp}`,title:'Alternate Phone'},
  {id:`CONTACT_CMAIL:${emp}`,title:'Company Email'},
  {id:`CONTACT_PMAIL:${emp}`,title:'Personal Email'},
  {id:`CONTACT_MAX:${emp}`,title:'MAX Number'},
  {id:`CONTACT_EXT:${emp}`,title:'Office Extension'},
  {id:`CONTACT_EMER:${emp}`,title:'Emergency Contact'},
  {id:`CONTACT_NOTES:${emp}`,title:'Notes'}
 ],'Contact Directory');return true;
}
if((a=text.match(/^CONTACT_(ALT|CMAIL|PMAIL|MAX|EXT|EMER|NOTES):(\d+)$/))){
 await pool.query(`INSERT INTO ui_sessions(whatsapp_number,session_key,session_value,updated_at) VALUES($1,'V851_CONTACT_EDIT',$2,now())
 ON CONFLICT(whatsapp_number,session_key) DO UPDATE SET session_value=EXCLUDED.session_value,updated_at=now()`,
 [normWA(from),JSON.stringify({field:a[1],employee_number:a[2]})]);
 const prompt={ALT:'Send alternate phone number',CMAIL:'Send company email ID',PMAIL:'Send personal email ID',MAX:'Send MAX number',EXT:'Send office extension',EMER:'Send emergency contact as: Name, Phone',NOTES:'Send contact notes'}[a[1]];
 await sendText(from,prompt);return true;
}
if((a=text.match(/^ADM_DATACLASS:(\d+)$/))){await sendText(from,'Testing mode is active. All non-Super-Admin users are automatically TESTER.');return true;}
if((a=text.match(/^SETCLASS:(\d+):(TESTER|MAIN)$/))){await sendText(from,'Testing mode is active. Manual Tester/Main switching is disabled.');return true;}
if((a=text.match(/^ADM_CAT:(\d+)$/))){await sendButtons(from,'Select Category',[{id:`SETCAT:${a[1]}:CONTRACT_WORKER`,title:'Contract Worker'},{id:`SETCAT:${a[1]}:NON_EXECUTIVE`,title:'Non-Executive'},{id:`SETCAT:${a[1]}:EXECUTIVE`,title:'Executive'}]);return true;}
if((a=text.match(/^SETCAT:(\d+):(CONTRACT_WORKER|NON_EXECUTIVE|EXECUTIVE)$/))){const emp=a[1],cat=a[2];await saveAdminOverrideV850(emp,{category:cat},normWA(from));await sendList(from,`${cat.replaceAll('_',' ')} hierarchy`,'Select',EMPLOYEE_HIERARCHY_V850[cat].map(([code,title])=>({id:`SETDES:${emp}:${code}`,title})),'Designation');await sendText(from,`✅ Category changed: ${cat.replaceAll('_',' ')}\nEmployee: ${emp}\nOnly Super Admin notified.`);return true;}
if((a=text.match(/^ADM_DESIG:(\d+)$/))){await sendButtons(from,'Select Category',[{id:`ADM_CAT:${a[1]}`,title:'Choose Category'}]);return true;}
if((a=text.match(/^SETDES:(\d+):([A-Z_]+)$/))){const emp=a[1],code=a[2];let title=null,cat=null;for(const [c,arr] of Object.entries(EMPLOYEE_HIERARCHY_V850)){const f=arr.find(x=>x[0]===code);if(f){title=f[1];cat=c;break;}}if(!title){await sendText(from,'Designation option not found.');return true;}const d=categoryDefaultAccessV850(cat,title),o=await saveAdminOverrideV850(emp,{category:cat,designation:title,operational_role:d.role,access_level:d.access},normWA(from));const u=await byEmp(emp);if(u)await applyAdminOverrideV850(u,o,normWA(from));await sendText(from,`✅ Designation changed: ${title}\nEmployee: ${emp}\nRole/Access refreshed.\nOnly Super Admin notified.`);return true;}
if((a=text.match(/^ADM_AREA:(\d+)$/))){await sendList(from,'Select Area','Select',LMMM_ORG.areas.map(x=>({id:`SETAREA:${a[1]}:${x.replaceAll(' ','_')}`,title:x})),'Area');return true;}
if((a=text.match(/^SETAREA:(\d+):([A-Z_]+)$/))){const emp=a[1],area=a[2].replaceAll('_',' '),o=await saveAdminOverrideV850(emp,{area,responsibility:null},normWA(from)),u=await byEmp(emp);if(u)await applyAdminOverrideV850(u,o,normWA(from));await sendText(from,`✅ Area changed: ${area}\nEmployee: ${emp}\nResponsibility refreshed.\nOnly Super Admin notified.`);return true;}
if((a=text.match(/^ADM_SECTION:(\d+)$/))){await sendList(from,'Select Section','Select',LMMM_ORG.sections.map(x=>({id:`SETSEC:${a[1]}:${x.replaceAll(' ','_')}`,title:x})),'Section');return true;}
if((a=text.match(/^SETSEC:(\d+):(.+)$/))){const emp=a[1],section=canonicalSection(a[2].replaceAll('_',' '));const patch=section==='HOD'?{section:'HOD',area:'LMMM',operational_role:'HOD',responsibility:'LMMM Department Head',scope:'LMMM_ALL'}:{section,responsibility:null};const o=await saveAdminOverrideV850(emp,patch,normWA(from)),u=await byEmp(emp);if(u)await applyAdminOverrideV850(u,o,normWA(from));await sendText(from,section==='HOD'?`✅ Section changed: HOD\nArea/Scope: LMMM\nRole: HOD\nEmployee: ${emp}\nOnly Super Admin notified.`:`✅ Section changed: ${section}\nEmployee: ${emp}\nResponsibility refreshed.\nOnly Super Admin notified.`);return true;}
if((a=text.match(/^ADM_SHIFT:(\d+)$/))){await sendButtons(from,'Select Shift',[{id:`SETSH:${a[1]}:General`,title:'General'},{id:`SETSH:${a[1]}:ROTATING_ABC`,title:'A/B/C Rotating'},{id:`SETSH2:${a[1]}`,title:'Fixed A/B/C'}]);return true;}
if((a=text.match(/^SETSH2:(\d+)$/))){await sendButtons(from,'Fixed Shift',[{id:`SETSH:${a[1]}:A`,title:'A Shift'},{id:`SETSH:${a[1]}:B`,title:'B Shift'},{id:`SETSH:${a[1]}:C`,title:'C Shift'}]);return true;}
if((a=text.match(/^SETSH:(\d+):(General|ROTATING_ABC|A|B|C)$/))){const emp=a[1],shift=a[2],o=await saveAdminOverrideV850(emp,{shift,responsibility:null},normWA(from)),u=await byEmp(emp);if(u)await applyAdminOverrideV850(u,o,normWA(from));await sendText(from,`✅ Shift changed: ${shift}\nEmployee: ${emp}\nOnly Super Admin notified.`);return true;}
  if((a=text.match(/^ADM_MORE:(\d+)$/))){await sendButtons(from,'More user controls',[
{id:`ADM_AUTH:${a[1]}`,title:'Authorities'},{id:`ADM_ADMINTOOLS:${a[1]}`,title:'Admin Tools'},{id:`ADM_REMOVE:${a[1]}`,title:'Remove User'}]);return true;}
if((a=text.match(/^ADM_ADMINTOOLS:(\d+)$/))){await sendList(from,'Admin Tools','Select',[
{id:`ADM_TEST:${a[1]}`,title:'Auto Assignment Test'},{id:`ADM_CONTACT:${a[1]}`,title:'Contact Details'},
{id:`ADM_VIEW:${a[1]}`,title:'Refresh Full Details'}],'Admin Tools');return true;}
  if((a=text.match(/^ADM_ROLE:(\d+)$/))){await sendButtons(from,'Select Role',[{id:`SR:${a[1]}:NON_EXECUTIVE`,title:'Non-Executive'},{id:`SR:${a[1]}:EXECUTIVE`,title:'Executive'},{id:`SR:${a[1]}:DGM`,title:'DGM'}]);return true;}
  if((a=text.match(/^ADM_ACCESS:(\d+)$/))){await sendList(from,'Select Access','Select',[
{id:`SA:${a[1]}:ENTRY`,title:'Entry Only'},{id:`SA:${a[1]}:VIEW_ONLY`,title:'View Only'},{id:`SA:${a[1]}:ENTRY_VIEW`,title:'Entry + View'},
{id:`SA:${a[1]}:EDIT`,title:'View + Edit / Entry'},{id:`SA:${a[1]}:FULL_ACCESS`,title:'Full Access'}],'Access Level');return true;}
  if((a=text.match(/^ADM_RESP:(\d+)$/))){await sendList(from,'Operational Responsibility','Select',OPERATIONAL_RESPONSIBILITIES_V850.map(([code,title])=>({id:`SETRESP:${a[1]}:${code}`,title})),'Responsibility');return true;}
  if((a=text.match(/^SR:(\d+):(.+)$/))){await setField(a[1],'role',a[2],admin);await showUser(from,await byEmp(a[1]));return true;}
  if((a=text.match(/^SA:(\d+):(ENTRY|VIEW_ONLY|ENTRY_VIEW|EDIT|FULL_ACCESS)$/))){await setAccessSyncedV858(a[1],a[2],admin);await sendText(from,`✅ Saved in real time\nAccess: ${a[2]}\nAuthorities replaced to match this access level.\nEmployee: ${a[1]}\nOnly Super Admin notified.`);await showUser(from,await byEmp(a[1]));return true;}
  if((a=text.match(/^SETRESP:(\d+):([A-Z_]+)$/))){const emp=a[1],role=a[2],u=await byEmp(emp);if(!u){await sendText(from,'Employee not found.');return true;}let base=workResponsibilityV83(u),scope='REGISTERED_AREA_SECTION';if(role==='AREA_INCHARGE'){base=canonicalArea(u.area_of_working);scope='AREA';}else if(role==='SECTION_INCHARGE'){base='LMMM';scope='LMMM_SECTION';}else if(role==='HOD'){base='LMMM Department Head';scope='LMMM_ALL';}else if(role==='SHIFT_INCHARGE'){base=`${canonicalArea(u.area_of_working)} ${canonicalSection(u.section_department)} shift`;scope='SHIFT_AREA_SECTION';}else if(role==='DGM'){base='LMMM';scope='LMMM_ALL';}else if(role==='SUPER_ADMIN'){base='LMMM';scope='LMMM_ALL';}const o=await saveAdminOverrideV850(emp,{operational_role:role,responsibility:base,scope},normWA(from));await applyAdminOverrideV850(u,o,normWA(from));await sendText(from,`✅ Responsibility changed: ${role.replaceAll('_',' ')}\nEmployee: ${emp}\nOnly Super Admin notified.`);return true;}
  if((a=text.match(/^SP:(\d+):(.+)$/))){await setField(a[1],'resp',a[2],admin);await showUser(from,await byEmp(a[1]));return true;}
  if((a=text.match(/^ADM_TEST:(\d+)$/))){const u=await byEmp(a[1]);if(!u){await sendText(from,'Employee not found.');return true;}await sendGovernanceTestV841(from,u);return true;}
  if((a=text.match(/^ADM_AUTH:(\d+)$/))){await sendButtons(from,'Authority Control',[
{id:`AUTH_CORE:${a[1]}`,title:'Core Access'},
{id:`AUTH_DOC:${a[1]}`,title:'Docs / Reports'},
{id:`AUTH_ADV:${a[1]}`,title:'Advanced'}]);return true;}
if((a=text.match(/^AUTH_CORE:(\d+)$/))){await sendList(from,'Core Authorities','Toggle',[
{id:`AU:${a[1]}:ENTRY`,title:'Entry'},{id:`AU:${a[1]}:VIEW`,title:'View'},{id:`AU:${a[1]}:EDIT`,title:'Edit / Correct'},
{id:`AU:${a[1]}:DELETE_UNDO`,title:'Delete / Undo'},{id:`AU:${a[1]}:APPROVAL`,title:'Approval'}],'Core Authorities');return true;}
if((a=text.match(/^AUTH_DOC:(\d+)$/))){await sendList(from,'Document & Report Authorities','Toggle',[
{id:`AU:${a[1]}:PDF`,title:'PDF'},{id:`AU:${a[1]}:PRINT_EXPORT`,title:'Print / Export'},
{id:`AU:${a[1]}:EXCEL`,title:'Excel'},{id:`AU:${a[1]}:REPORTS`,title:'Reports'}],'Docs / Reports');return true;}
if((a=text.match(/^AUTH_ADV:(\d+)$/))){await sendList(from,'Advanced Authorities','Toggle',[
{id:`AU:${a[1]}:ANALYSIS`,title:'Analysis'},{id:`AU:${a[1]}:ADVANCED_REPORTS`,title:'Advanced Reports'},
{id:`AU:${a[1]}:RCM`,title:'RCM Analysis'}],'Advanced');return true;}
  if((a=text.match(/^AU:(\d+):(ENTRY|VIEW|EDIT|DELETE_UNDO|APPROVAL|PDF|PRINT_EXPORT|EXCEL|ANALYSIS|REPORTS|ADVANCED_REPORTS|RCM)$/))){const ac=await toggleAuthoritySyncedV858(a[1],a[2],admin);await sendText(from,`✅ Saved in real time\nAuthority: ${a[2]} toggled\nAccess now: ${ac}\nOnly Super Admin notified.`);await showUser(from,await byEmp(a[1]));return true;}
  if((a=text.match(/^ADM_REMOVE:(\d+)$/))){await sendButtons(from,'Remove this user? Maintenance history will be preserved.',[{id:`ADM_REMOVE_YES:${a[1]}`,title:'Yes, Remove'},{id:`ADM_VIEW:${a[1]}`,title:'Cancel'}]);return true;}
  if((a=text.match(/^ADM_REMOVE_YES:(\d+)$/))){const u=await byEmp(a[1]);if(!u){await sendText(from,'Employee not found.');return true;}await removeRegistration(u,admin);await pool.query('DELETE FROM user_access_profile WHERE employee_number=$1',[a[1]]);await sendText(u.whatsapp_number,'Your registration has been removed. Send Hi to re-register.');await sendText(from,`${u.name} / ${u.employee_number} removed.`);return true;}
  if(/^\d+$/.test(text)||/^[A-Za-z][A-Za-z .'-]{1,60}$/.test(text)){
    const r=await pool.query(`SELECT * FROM users WHERE employee_number=$1 OR lower(name)=lower($1) OR lower(name) LIKE lower($2) ORDER BY name LIMIT 3`,[text,`%${text}%`]);
    if(r.rowCount===1){await showUser(from,r.rows[0]);return true;}
    if(r.rowCount>1){await sendButtons(from,'Select user',r.rows.map(u=>({id:`ADM_VIEW:${u.employee_number}`,title:`${u.name} ${u.employee_number}`.slice(0,20)})));return true;}
  }

  let m=text.match(/^APPROVE:(\d+)$/i) || text.match(/^approve\s+(\d+)$/i);
  if(m){
    const u=await byEmp(m[1]); if(!u){await sendText(from,'Employee not found.');return true;}
    const role=roleFromDesignation(u.designation);
    await pool.query(`UPDATE users SET approval_status='approved',is_active=true,operational_role=$2,updated_at=now() WHERE employee_number=$1`,[m[1],role]);
    await resetProfileToAutoV841(u,normWA(from));
    await audit(u,'APPROVED',normWA(from),{role,area:u.area_of_working,designation:u.designation});
    await sendButtons(u.whatsapp_number,'Welcome to LMMM Maintenance.',[
      {id:'MENU_SEARCH',title:'Search'},{id:'MENU_ADD',title:'Add Entry'},{id:'MENU_ACCOUNT',title:'My Account'}]);
    if(normWA(from)!==u.whatsapp_number) await sendButtons(from,`${u.name} / ${u.employee_number} approved.`,
[{id:`ADM_ASSIGN:${u.employee_number}`,title:'Assign Access'},{id:`ADM_VIEW:${u.employee_number}`,title:'View User'},{id:'ADM_USERS',title:'User Management'}]);
    return true;
  }
  m=text.match(/^REJECT:(\d+)$/i) || text.match(/^reject\s+(\d+)$/i);
  if(m){
    const u=await byEmp(m[1]); if(!u){await sendText(from,'Employee not found.');return true;}
    await audit(u,'REJECTED',normWA(from),{});
    await pool.query('DELETE FROM users WHERE employee_number=$1',[m[1]]);
    await sendText(u.whatsapp_number,'Registration rejected. Send Hi to register again.');
    if(normWA(from)!==u.whatsapp_number) await sendText(from,`${m[1]} rejected.`);
    return true;
  }
  m=text.match(/^REMOVE:(\d+)$/i) || text.match(/^remove\s+(\d+)$/i);
  if(m){
    const u=await byEmp(m[1]); if(!u){await sendText(from,'Employee not found.');return true;}
    await removeRegistration(u,normWA(from));
    await sendText(u.whatsapp_number,'Your LMMM Maintenance registration has been removed. Send Hi to re-register.');
    if(normWA(from)!==u.whatsapp_number) await sendText(from,`${m[1]} registration removed. Maintenance history preserved.`);
    return true;
  }
  if(/^version$/i.test(text)){await sendText(from,'LMMM AI Maintenance V8.7.7 CONFIRM BEFORE STORE');return true;}
  return false;
}
async function hasAuthorityV874(u, authority){
  if(isOwner(u?.whatsapp_number)) return true;
  if(!u?.employee_number) return false;
  await ensureProfile(u,normWA(u.whatsapp_number));
  const r=await pool.query('SELECT authorities FROM user_access_profile WHERE employee_number=$1',[u.employee_number]);
  return (r.rows[0]?.authorities||[]).includes(authority);
}
async function setIngestModeV874(from,on=true){
  if(on) await pool.query(`INSERT INTO ui_sessions(whatsapp_number,session_key,session_value,updated_at) VALUES($1,'FILE_INGEST', $2::jsonb,now()) ON CONFLICT(whatsapp_number,session_key) DO UPDATE SET session_value=EXCLUDED.session_value,updated_at=now()`,[normWA(from),JSON.stringify({active:true})]);
  else await pool.query(`DELETE FROM ui_sessions WHERE whatsapp_number=$1 AND session_key='FILE_INGEST'`,[normWA(from)]);
}
async function ingestModeV874(from){
  const r=await pool.query(`SELECT session_value FROM ui_sessions WHERE whatsapp_number=$1 AND session_key='FILE_INGEST'`,[normWA(from)]);return !!r.rows[0]?.session_value?.active;
}
async function downloadWhatsAppMediaV874(mediaId){
  const meta=await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`,{headers:{Authorization:`Bearer ${ACCESS_TOKEN}`}});
  if(!meta.ok) throw new Error(`Media metadata failed ${meta.status}`);
  const m=await meta.json();
  const bin=await fetch(m.url,{headers:{Authorization:`Bearer ${ACCESS_TOKEN}`}});
  if(!bin.ok) throw new Error(`Media download failed ${bin.status}`);
  const ab=await bin.arrayBuffer(); return {bytes:Buffer.from(ab),mime:m.mime_type||bin.headers.get('content-type')||'application/octet-stream'};
}
function safeJsonV874(t=''){
  const x=String(t).replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'').trim();
  try{return JSON.parse(x)}catch{const a=x.indexOf('['),b=x.lastIndexOf(']');if(a>=0&&b>a)try{return JSON.parse(x.slice(a,b+1))}catch{};return null;}
}

function strongTechnicalReferenceEvidenceV8125(text='',filename=''){
  const t=`${filename}\n${text}`.toLowerCase();
  const strongTitle=/\b(list\s+of\s+.*drawings?|drawing\s+list|mechanical\s+drawings?|technical\s+data|parts?\s+list|spares?\s+list|bill\s+of\s+materials?|boq|equipment\s+manual|maintenance\s+manual|service\s+manual|central(?:is|iz)ed\s+lubrication|lubrication\s+(?:system|equipment|manual|drawing)|hydraulic\s+(?:system|equipment|manual)|pneumatic\s+(?:system|equipment|manual)|equipment\s+(?:data|list|drawing)|permit|inspection\s+(?:format|sheet|record)|maintenance\s+(?:format|record|history))\b/i.test(t);
  const drawingColumns=/drawing\s*(?:no|number|nos|numbers)\b/i.test(t) && /\bdesignation\b/i.test(t);
  const repeatedDrawingIds=(t.match(/\b(?:[a-z]?\d[\d.-]{3,}\d)\b/gi)||[]).length>=2;
  const examSignals=/\b(question\s*paper|objective\s*questions?|multiple\s*choice|ncvt|rrb|iti\s+exam|trade\s+test)\b/i.test(t);
  if(examSignals && !strongTitle && !drawingColumns) return false;
  return strongTitle || (drawingColumns && repeatedDrawingIds);
}
async function geminiFetchV890(url,options={},timeoutMs=45000){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),Math.max(1000,Number(timeoutMs)||45000));
  try{return await fetch(url,{...options,signal:ctrl.signal});}
  catch(e){if(e?.name==='AbortError'){const x=new Error(`AI request timeout after ${timeoutMs}ms`);x.code='AI_TIMEOUT';throw x;}throw e;}
  finally{clearTimeout(timer);}
}
async function classifyTechnicalRelevanceV886(bytes,mime,filename,caption){
  if(!GEMINI_API_KEY && !GROQ_API_KEY && !OPENROUTER_API_KEY) throw new Error('No free AI provider configured');
  const prompt=`You are the intake gate for the RINL/VSP LMMM maintenance knowledge system.
Decide PROJECT RELEVANCE, not whether the page merely contains technical words.

ACCEPT as LMMM_RELEVANT only when the source is plausibly useful to LMMM plant work: plant equipment, mechanical/electrical/instrumentation maintenance, operations, equipment drawings/drawing lists, manuals, spares/parts, BOQ, logbooks, inspections, condition monitoring, shutdowns, work orders, production, plant safety/procedures, or an engineering reference directly useful to industrial maintenance.

REJECT as UNRELATED when it is a general competitive/trade/school exam question paper, generic classroom worksheet, personal/social/entertainment content, or other material not intended as LMMM/plant maintenance knowledge. A page being about "trade/basic fitting" or having technical terms does NOT by itself make an exam/question paper LMMM relevant.

If the source is a drawing/parts/manual/BOQ list, classify it LMMM_RELEVANT even when exact LMMM equipment mapping is not yet known; mapping can remain NEEDS_REVIEW.

Return ONLY JSON:
{"relevance":"LMMM_RELEVANT|UNRELATED|UNCERTAIN","reason":"short English reason","document_type":"DRAWING_LIST|PARTS_LIST|MANUAL_REFERENCE|BOQ|LOGBOOK|INSPECTION|DEFECT|JOB|TRAINING_REFERENCE|OTHER"}
Filename: ${filename||'(unknown)'}
Caption: ${caption||'(none)'}`;
  const body={contents:[{parts:[{text:prompt},{inline_data:{mime_type:mime,data:bytes.toString('base64')}}]}],generationConfig:{responseMimeType:'application/json',maxOutputTokens:512}};
  const gx=await geminiGenerateWithFallbackV892(body,60000);
  const j=await gx.response.json(),txt=(j.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('');
  return safeJsonV874(txt)||{relevance:'UNCERTAIN',reason:'Could not confidently classify',document_type:'OTHER'};
}


function geminiModelCandidatesV892(){
  // Use only models explicitly configured for this deployment. Do not waste time on guessed model names.
  const raw=[GEMINI_MODEL,process.env.GEMINI_FALLBACK_MODEL]
    .filter(Boolean).map(x=>String(x).trim()).filter(Boolean);
  return [...new Set(raw)];
}
function geminiBodyToOpenAIContentV8110(body){
  const parts=body?.contents?.flatMap(x=>x.parts||[])||[], out=[];
  for(const p of parts){
    if(p.text) out.push({type:'text',text:String(p.text)});
    const d=p.inline_data||p.inlineData;
    if(d?.data){
      const mime=String(d.mime_type||d.mimeType||'application/octet-stream');
      const url=`data:${mime};base64,${d.data}`;
      if(/^image\//i.test(mime)) out.push({type:'image_url',image_url:{url}});
      else if(/pdf/i.test(mime)) out.push({type:'file',file:{filename:'document.pdf',file_data:url}});
      else if(/^audio\//i.test(mime)) out.push({type:'input_audio',input_audio:{data:d.data,format:mime.includes('wav')?'wav':mime.includes('mpeg')?'mp3':'ogg'}});
    }
  }
  return out;
}
function openAITextAsGeminiResponseV8110(text){
  return {ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:String(text||'')}]}}]})};
}
async function openAIUniversalGenerateV8132(body,timeoutMs=90000){
  if(!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
  const parts=body?.contents?.flatMap(x=>x.parts||[])||[];
  const prompts=parts.filter(p=>p.text).map(p=>String(p.text));
  const audioPart=parts.find(p=>{const d=p.inline_data||p.inlineData;return d?.data&&/^audio\//i.test(String(d.mime_type||d.mimeType||''));});
  let transcript='';
  if(audioPart){
    const d=audioPart.inline_data||audioPart.inlineData, mime=String(d.mime_type||d.mimeType||'audio/ogg').split(';')[0];
    const ext=mime.includes('mpeg')?'mp3':mime.includes('wav')?'wav':mime.includes('mp4')?'m4a':'ogg';
    const fd=new FormData();
    fd.append('file',new Blob([Buffer.from(d.data,'base64')],{type:mime}),`voice.${ext}`);
    fd.append('model',process.env.OPENAI_TRANSCRIBE_MODEL||'gpt-4o-transcribe');
    const ac=new AbortController(), at=setTimeout(()=>ac.abort(),Math.min(Math.max(timeoutMs,60000),120000));
    try{
      const ar=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',signal:ac.signal,headers:{Authorization:`Bearer ${OPENAI_API_KEY}`},body:fd});
      if(!ar.ok) throw new Error(`OpenAI transcription ${ar.status}: ${(await ar.text()).slice(0,500)}`);
      const aj=await ar.json(); transcript=String(aj.text||'').trim();
      if(!transcript) throw new Error('OpenAI transcription empty');
    }finally{clearTimeout(at);}
  }
  const content=[];
  if(prompts.length||transcript) content.push({type:'input_text',text:[...prompts,transcript?`\nSOURCE AUDIO TRANSCRIPT:\n${transcript}`:''].filter(Boolean).join('\n')});
  for(const p of parts){
    const d=p.inline_data||p.inlineData; if(!d?.data) continue;
    const mime=String(d.mime_type||d.mimeType||'application/octet-stream').split(';')[0];
    const data=`data:${mime};base64,${d.data}`;
    if(/^image\//i.test(mime)) content.push({type:'input_image',image_url:data,detail:'high'});
    else if(/pdf/i.test(mime)) content.push({type:'input_file',filename:'lmmm-source.pdf',file_data:data});
    else if(!/^audio\//i.test(mime)) content.push({type:'input_file',filename:'lmmm-source.bin',file_data:data});
  }
  if(!content.length) throw new Error('OpenAI fallback received no usable input');
  const ctrl=new AbortController(), timer=setTimeout(()=>ctrl.abort(),Math.min(Math.max(timeoutMs,60000),120000));
  try{
    const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:ctrl.signal,headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:OPENAI_MODEL,input:[{role:'user',content}],max_output_tokens:body?.generationConfig?.maxOutputTokens||8192})});
    if(!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0,700)}`);
    const j=await r.json();
    const txt=String(j.output_text||'')||(j.output||[]).flatMap(o=>o.content||[]).map(c=>c.text||'').join('\n');
    if(!txt.trim()) throw new Error('OpenAI empty response');
    return {model:j.model||OPENAI_MODEL,response:openAITextAsGeminiResponseV8110(txt.trim()),provider:'OPENAI'};
  }catch(e){if(e?.name==='AbortError'){const x=new Error('OpenAI fallback timeout');x.code='OPENAI_TIMEOUT';throw x;}throw e;}finally{clearTimeout(timer);}
}
async function openRouterGenerateV8110(body,timeoutMs=60000){
  if(!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing');
  const content=geminiBodyToOpenAIContentV8110(body);
  const r=await geminiFetchV890('https://openrouter.ai/api/v1/chat/completions',{
    method:'POST',headers:{Authorization:`Bearer ${OPENROUTER_API_KEY}`,'Content-Type':'application/json','X-Title':'LMMM AI Maintenance'},
    body:JSON.stringify({
      model:process.env.OPENROUTER_MODEL||'openrouter/free',
      messages:[{role:'user',content}],
      max_tokens:body?.generationConfig?.maxOutputTokens||4096,
      ...(content.some(x=>x.type==='file') ? {plugins:[{id:'file-parser',pdf:{engine:'pdf-text'}}]} : {})
    })
  },timeoutMs);
  if(!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0,500)}`);
  const j=await r.json(),text=j?.choices?.[0]?.message?.content;
  if(!text) throw new Error('OpenRouter empty response');
  return {model:j.model||process.env.OPENROUTER_MODEL||'openrouter/free',response:openAITextAsGeminiResponseV8110(text),provider:'OPENROUTER'};
}
async function groqGenerateV8110(body,timeoutMs=60000){
  if(!GROQ_API_KEY) throw new Error('GROQ_API_KEY missing');
  const content=geminiBodyToOpenAIContentV8110(body);
  // Groq vision accepts images; skip PDF/file/audio here so the durable queue can use another capable provider.
  if(content.some(x=>x.type==='file'||x.type==='input_audio')) throw new Error('Groq modality unsupported for this fallback');
  const r=await geminiFetchV890('https://api.groq.com/openai/v1/chat/completions',{
    method:'POST',headers:{Authorization:`Bearer ${GROQ_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:process.env.GROQ_MODEL||'qwen/qwen3.8-27b',messages:[{role:'user',content}],max_completion_tokens:body?.generationConfig?.maxOutputTokens||4096})
  },timeoutMs);
  if(!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0,500)}`);
  const j=await r.json(),text=j?.choices?.[0]?.message?.content;
  if(!text) throw new Error('Groq empty response');
  return {model:j.model||process.env.GROQ_MODEL||'qwen/qwen3.8-27b',response:openAITextAsGeminiResponseV8110(text),provider:'GROQ'};
}
let geminiCooldownUntilV8128=0;
async function geminiOnlyGenerateWithFallbackV8110(body,timeoutMs=45000){
  if(Date.now()<geminiCooldownUntilV8128){
    const e=new Error('Gemini temporary cooldown active'); e.code='GEMINI_COOLDOWN'; throw e;
  }
  const models=geminiModelCandidatesV892();
  let lastErr=null;
  // V8.12.8: Gemini remains first priority, but do NOT burn time cycling all Gemini
  // models during quota/high-demand incidents. Try preferred model first.
  for(let i=0;i<models.length;i++){
    const model=models[i];
    const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    try{
      const r=await geminiFetchV890(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},Math.min(timeoutMs,90000));
      if(r.ok) return {response:r,model};
      const raw=await r.text();
      console.error('[GEMINI_MODEL_FAIL]',JSON.stringify({model,attempt:1,status:r.status,error:raw.slice(0,500)}));
      lastErr=new Error(`Gemini ${model} failed ${r.status}: ${raw.slice(0,300)}`);
      lastErr.status=r.status;
      // 429/5xx = provider temporarily unavailable. Fail over NOW instead of trying
      // every Gemini model. Cooldown prevents every PDF page hammering Gemini again.
      if([429,500,502,503,504].includes(r.status)){
        geminiCooldownUntilV8128=Date.now()+300000;
        lastErr.code=r.status===429?'GEMINI_QUOTA':'GEMINI_TEMP_UNAVAILABLE';
        throw lastErr;
      }
      // 404/400 can be model-specific/config-specific: allow only one alternate model.
      if(i>=1) throw lastErr;
    }catch(e){
      if(e?.name==='AbortError'){
        geminiCooldownUntilV8128=Date.now()+300000;
        const te=new Error('Gemini timeout; immediate provider failover'); te.code='GEMINI_TIMEOUT'; throw te;
      }
      if(e?.code||[429,500,502,503,504].includes(e?.status)) throw e;
      lastErr=e;
      console.error('[GEMINI_MODEL_ERROR]',model,1,String(e));
      if(i>=1) throw e;
    }
  }
  throw lastErr||new Error('Gemini unavailable');
}
async function geminiGenerateWithFallbackV892(body,timeoutMs=45000){
  const failures=[];
  const content=geminiBodyToOpenAIContentV8110(body);
  const hasFile=content.some(x=>x.type==='file');
  const hasAudio=content.some(x=>x.type==='input_audio');

  // V8.13.3: OpenAI is primary wherever the modality is supported because the
  // current LMMM technical-document tests are more accurate with it. Gemini is
  // the immediate quality backup. Tertiary providers are text/image-only.
  if(OPENAI_ENABLED){
    try{
      console.log('[AI_PROVIDER_TRY] OPENAI');
      const x=await openAIUniversalGenerateV8132(body,Math.max(timeoutMs,90000));
      console.log('[AI_PROVIDER_OK] OPENAI',x.model); return x;
    }catch(e){failures.push(`OPENAI:${e.message}`);console.error('[AI_PROVIDER_FAIL] OPENAI',e.code||'',e.message);}
  }else if(!FREE_AI_ONLY) failures.push('OPENAI:key missing');

  try{
    console.log('[AI_PROVIDER_TRY] GEMINI');
    const x=await geminiOnlyGenerateWithFallbackV8110(body,Math.max(timeoutMs,90000));
    console.log('[AI_PROVIDER_OK] GEMINI',x.model); return {...x,provider:'GEMINI'};
  }catch(e){failures.push(`GEMINI:${e.message}`);console.error('[AI_PROVIDER_FAIL] GEMINI',e.code||'',e.status||'',e.message);}

  if(!hasFile&&!hasAudio&&GROQ_API_KEY){
    try{console.log('[AI_PROVIDER_TRY] GROQ');const x=await groqGenerateV8110(body,20000);console.log('[AI_PROVIDER_OK] GROQ',x.model);return x;}
    catch(e){failures.push(`GROQ:${e.message}`);console.error('[AI_PROVIDER_FAIL] GROQ',e.message);}
  }
  if(!hasFile&&!hasAudio&&OPENROUTER_API_KEY){
    try{console.log('[AI_PROVIDER_TRY] OPENROUTER');const x=await openRouterGenerateV8110(body,30000);console.log('[AI_PROVIDER_OK] OPENROUTER',x.model);return x;}
    catch(e){failures.push(`OPENROUTER:${e.message}`);console.error('[AI_PROVIDER_FAIL] OPENROUTER',e.message);}
  }
  const e=new Error(`All capable AI providers failed: ${failures.join(' | ')}`); e.code='AI_ALL_PROVIDERS_FAILED'; throw e;
}

async function extractMaintenanceCoreV887(bytes,mime,filename,caption,compact=false){
  if(!GEMINI_API_KEY && !GROQ_API_KEY && !OPENROUTER_API_KEY && !OPENAI_ENABLED) throw new Error('No enabled AI provider key configured');
  const ext=String(filename||'').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]||'';
  const mime0=String(mime||'application/octet-stream').toLowerCase();
  const extMime={pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',tif:'image/tiff',tiff:'image/tiff',txt:'text/plain',csv:'text/csv',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xlsm:'application/vnd.ms-excel.sheet.macroenabled.12',mdb:'application/vnd.ms-access',accdb:'application/vnd.ms-access',ogg:'audio/ogg',opus:'audio/ogg',mp3:'audio/mpeg',m4a:'audio/mp4',aac:'audio/aac',wav:'audio/wav'};
  const supportedExt=new Set(Object.keys(extMime));
  if(!supportedExt.has(ext) && !['application/pdf','image/jpeg','image/png','image/webp','image/tiff','text/plain','text/csv','audio/ogg','audio/mpeg','audio/mp4','audio/aac','audio/wav'].some(x=>mime0.startsWith(x))) throw new Error(`UNSUPPORTED:${mime0}`);
  let sendMime=(mime0==='application/octet-stream'||mime0==='binary/octet-stream')?(extMime[ext]||mime0):mime0;
  // WhatsApp voice notes commonly arrive as audio/ogg; codecs=opus. Gemini expects the base MIME.
  if(sendMime.startsWith('audio/ogg')) sendMime='audio/ogg';
  if(sendMime.startsWith('audio/mp4')) sendMime='audio/mp4';
  if(sendMime.startsWith('audio/mpeg')) sendMime='audio/mpeg';
  const prompt=`You are the source-faithful file extraction and maintenance classification engine for RINL/VSP LMMM Dept-35.\n${compact?'RETRY MODE: keep JSON compact; prioritize exact identifiers, rows, equipment, dates, technical descriptions and records. Do not add commentary.':''}

The source may contain English, Telugu, Hindi, Tenglish, handwriting, scans, tables, BOQ, drawings lists, manuals, spreadsheets, maintenance records, or WhatsApp voice/audio. For audio, transcribe the complete intelligible speech first and then apply the same maintenance classification rules.

CRITICAL RULES:
1. Read EVERY page/frame of the source, not only page 1 and not only a summary. For multi-page PDF/TIFF, process pages in order and extract every legible row/item from every page. Transcribe all legible meaningful text and table rows in source order into full_text. Do not intentionally omit BOQ items, drawing numbers, part numbers, quantities, dates, headings or maintenance lines. If something is unreadable, write [UNREADABLE] instead of guessing.
1A. For DRAWING_LIST/PARTS_LIST/BOQ/table reference documents, extracted_items is the PRIMARY table output. Put each legible source row there. Do NOT duplicate every reference row into records. records is only for genuine maintenance events (defect/job/inspection/history/etc.). For a pure drawing/parts/BOQ reference list, records may contain one document-level NEEDS_REVIEW record while extracted_items carries the table rows.
1B. For multi-page reference lists, extract as many complete rows as fit safely. Never invent missing rows. Preserve page/item/drawing/part identifiers exactly.
2. Separately classify the whole document. A BOQ/drawing list/manual/reference document is NOT a set of maintenance events.
3. Never invent or expand Equipment/SAP/Sub-equipment/Drawing/Part identifiers. A generic phrase such as "mill equipment", "repair of mill equipment", a contractor name or document title is NOT an equipment identity. If an exact equipment mapping is not supported by the source, equipment=null and confidence=NEEDS_REVIEW.
4. For genuine transaction/event content, split only real independent events by explicit equipment/date. For reference documents, use one document-level record and preserve detailed rows in extracted_items.
5. Normalize ALL user-facing extracted meaning and ALL stored structured maintenance data into clear concise technical English, regardless of whether the source is Telugu, Hindi, Tenglish, mixed language or English. Preserve exact identifiers/numbers/readings unchanged.
5A. full_text must preserve the source transcription for audit/source fidelity. ALSO return review_text_english containing a faithful, complete English translation/rendering of the meaningful source content in the SAME order. Translate what the source actually says; do not paraphrase a Hindi/Telugu question, instruction, option, technical term or sentence into a different meaning. Preserve question numbering, item numbering, quantities, negation, units and technical terms. If a word cannot be read confidently, use [UNREADABLE] rather than inventing a translation. For already-English source, review_text_english may equal full_text.
5B. For non-maintenance educational/general documents, translate faithfully but classify UNRELATED; never reinterpret them as maintenance records.
6. Unrelated content (for example an exam/question paper) must be document_type=UNRELATED and the record must be NEEDS_REVIEW; it must never become maintenance history.
7. Missing or ambiguous date/equipment/module => null where appropriate and NEEDS_REVIEW. Never use today's date for historical source data.

Return ONLY one JSON object:
{
 "document_type":"MAINTENANCE_EVENT|LOGBOOK|BOQ|DRAWING_LIST|MANUAL|REFERENCE|SPREADSHEET|UNRELATED|OTHER",
 "detected_languages":["..."],
 "document_summary":"short source-faithful summary in English",
 "full_text":"complete meaningful source transcription; for large tabular drawing/parts/BOQ lists, headings plus structured extracted_items are sufficient and rows need not be duplicated here",
 "review_text_english":"complete clear English rendering of the meaningful extracted source content in source order",
 "extracted_items":[{"item_no":"","identifier":"","description":"","quantity":"","unit":"","remarks":""}],
 "records":[
  {"module":"LOG_BOOK|BREAKDOWN_DELAY|DEFECT|JOB|PM|INSPECTION|CBM_VIBRATION|HISTORY|SPARES|DRAWING_DOCS|MANUAL_REFERENCE|SHUTDOWN|ATTENDANCE|MANPOWER|NEEDS_REVIEW",
   "area":null,"equipment":null,"sub_equipment":null,"event_date":null,"event_time":null,"shift":null,
   "description":"","action_taken":null,"status":null,"remarks":null,"confidence":"HIGH|MEDIUM|NEEDS_REVIEW"}
 ]
}
Caption: ${caption||'(none)'}
Filename: ${filename||'(unknown)'}
Source format: ${ext||sendMime}.`;
  const body={contents:[{parts:[{text:prompt},{inline_data:{mime_type:sendMime,data:bytes.toString('base64')}}]}],
    generationConfig:{responseMimeType:'application/json',maxOutputTokens:4096}};
  const gx=await geminiGenerateWithFallbackV892(body,45000),r=gx.response;
  console.log('[AI_USED]',gx.provider||'GEMINI',gx.model,'structured');
  const j=await r.json(),txt=(j.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('');
  const out=safeJsonV874(txt);
  if(Array.isArray(out)) return {document_type:'OTHER',detected_languages:[],document_summary:'',full_text:'',extracted_items:[],records:out.slice(0,250)};
  if(!out || !Array.isArray(out.records)) throw new Error('Extraction JSON invalid');
  return {
    document_type:String(out.document_type||'OTHER').toUpperCase(),
    detected_languages:Array.isArray(out.detected_languages)?out.detected_languages.slice(0,10):[],
    document_summary:String(out.document_summary||'').slice(0,4000),
    full_text:String(out.full_text||'').slice(0,120000),
    review_text_english:String(out.review_text_english||out.full_text||'').slice(0,120000),
    extracted_items:Array.isArray(out.extracted_items)?out.extracted_items.slice(0,1000):[],
    records:out.records.slice(0,250)
  };
}
async function extractReferenceFallbackV889(bytes,mime,filename,caption){
  if(!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing');
  const prompt=`RINL/VSP LMMM technical reference extraction fallback.
This source has already been accepted for technical inspection. Extract useful source-backed engineering reference data without guessing.
For PDF/TIFF/image drawing lists, parts lists, BOQ, manuals or tables:
- inspect all pages/frames available to you;
- preserve exact drawing/part/item identifiers and designations;
- return rows only when legible;
- do not invent equipment mapping;
- do not create fake defects/jobs/history;
- unreadable = [UNREADABLE].
Return ONLY compact JSON:
{"document_type":"DRAWING_LIST|PARTS_LIST|BOQ|MANUAL_REFERENCE|TECHNICAL_REFERENCE|OTHER",
"detected_languages":["English"],
"document_summary":"short English summary",
"review_text_english":"concise English review text",
"extracted_items":[{"page":null,"item_no":null,"identifier":null,"description":null,"quantity":null,"unit":null,"remarks":null}],
"records":[{"module":"KNOWLEDGE","area":null,"equipment":null,"sub_equipment":null,"event_date":null,"description":"document-level description","confidence":"NEEDS_REVIEW"}]}
Do not duplicate table rows in records.
Filename: ${filename||'(unknown)'}
Caption: ${caption||'(none)'}`;
  const body={contents:[{parts:[{text:prompt},{inline_data:{mime_type:mime,data:bytes.toString('base64')}}]}],
    generationConfig:{responseMimeType:'application/json',maxOutputTokens:4096}};
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
  });
  if(!r.ok) throw new Error(`Reference fallback failed ${r.status}: ${(await r.text()).slice(0,500)}`);
  const j=await r.json(),txt=(j.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('');
  const out=safeJsonV874(txt); if(!out) throw new Error('Reference fallback JSON parse failed');
  out.full_text=String(out.review_text_english||out.document_summary||'').slice(0,120000);
  out.review_text_english=String(out.review_text_english||out.full_text||'').slice(0,120000);
  out.extracted_items=Array.isArray(out.extracted_items)?out.extracted_items:[];
  out.records=Array.isArray(out.records)?out.records:[];
  return out;
}


async function openAIPdfExtractV8131(bytes,mime,prompt,timeoutMs=120000){
  if(!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  try{
    const r=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',signal:ctrl.signal,
      headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        model:OPENAI_MODEL,
        input:[{role:'user',content:[
          {type:'input_text',text:prompt},
          {type:'input_file',filename:'lmmm-source.pdf',file_data:`data:${mime||'application/pdf'};base64,${bytes.toString('base64')}`,detail:'high'}
        ]}],
        max_output_tokens:32768
      })
    });
    if(!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0,700)}`);
    const j=await r.json();
    const txt=String(j.output_text||'') || (j.output||[]).flatMap(o=>o.content||[]).map(c=>c.text||'').join('\n');
    if(!txt.trim()) throw new Error('OpenAI empty PDF extraction response');
    return {text:txt.trim(),model:j.model||OPENAI_MODEL,provider:'OPENAI'};
  }catch(e){
    if(e?.name==='AbortError'){const x=new Error('OpenAI PDF extraction timeout');x.code='OPENAI_TIMEOUT';throw x;}
    throw e;
  }finally{clearTimeout(timer);}
}

async function extractPdfBatchesV897(bytes,mime,filename,caption){
  const m=String(filename).match(/(\d+)\s*-\s*(\d+)/), totalHint=Number((m||[])[2]||0);
  const expected=totalHint>0&&totalHint<=200?totalHint:null;
  const all=[], pageStats=[];
  const parseRows=(txt,forcedPage=null)=>{
    const rows=[];
    for(const raw of String(txt||'').split(/\r?\n/)){
      const line=raw.trim(); if(!/^ROW\|/i.test(line)) continue;
      const p=line.split('|');
      const pg=forcedPage||Number(String(p[1]||'').replace(/\D/g,''))||null;
      const row={page:pg?String(pg):null,item_no:(p[2]||'').trim()||null,identifier:(p[3]||'').trim()||null,description:(p[4]||'').trim()||null,quantity:(p[5]||'').trim()||null,unit:(p[6]||'').trim()||null,remarks:(p.slice(7).join('|')||'').trim()||null};
      if(row.identifier||row.description) rows.push(row);
    }
    return rows;
  };

  // V8.13.1: ACCURATE PDF path: Gemini gets up to 90s; OpenAI is quality fallback.
  // V8.13.0: FAST + ACCURATE PDF path. Gemini gets the whole PDF once first.
  // OpenRouter/Groq are intentionally NOT used for raw PDF extraction because a
  // fallback model can flatten page boundaries and silently create incomplete data.
  const prompt=`Read the ENTIRE PDF from first page to last page. This is an industrial drawing/reference list.
Extract EVERY legible printed data row from EVERY page. Do not summarize, sample, merge or omit repeated-looking rows.
Return ONLY lines in this exact format:
ROW|printed page number|item number|exact identifier|exact designation/description|quantity|unit|remarks
Preserve drawing/part identifiers character-for-character. Leave absent fields empty. Never copy the filename into quantity/unit/remarks.
Use the actual PDF page number (1,2,3...). Continue through the final page.${expected?` Expected PDF pages: ${expected}.`:''}`;
  const body={contents:[{parts:[{text:prompt},{inline_data:{mime_type:mime,data:bytes.toString('base64')}}]}],generationConfig:{maxOutputTokens:32768}};
  let gx=null;
  // FREE_AI_ONLY default: paid OpenAI is hard-disabled. Gemini is the primary PDF extractor; free fallbacks are validation-gated.
  if(OPENAI_ENABLED){
    try{
      console.log('[PDF_OPENAI_PRIMARY_TRY]',filename,OPENAI_MODEL);
      const ox=await openAIPdfExtractV8131(bytes,mime,prompt,150000);
      console.log('[PDF_OPENAI_PRIMARY_OK]',filename,ox.model);
      all.push(...parseRows(ox.text));
    }catch(oe){console.error('[PDF_OPENAI_PRIMARY_FAIL]',filename,oe?.code||'',oe?.message||oe);}
  }
  if(!all.length){
    try{
      gx=await geminiOnlyGenerateWithFallbackV8110(body,120000);
      console.log('[PDF_GEMINI_BACKUP_OK]',filename,gx.model);
      const j=await gx.response.json(), txt=(j.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('').trim();
      all.push(...parseRows(txt));
    }catch(e){
      console.error('[PDF_GEMINI_BACKUP_FAIL]',filename,e?.code||'',e?.message||e);
      const q=new Error(`Free PDF extraction providers temporarily unavailable; source retained for retry. ${e?.message||''}`);
      q.code=e?.code||'PDF_AI_RETRY'; throw q;
    }
  }

  let represented=[...new Set(all.map(x=>Number(x.page)).filter(Boolean))].sort((a,b)=>a-b);
  let missing=expected?Array.from({length:expected},(_,i)=>i+1).filter(x=>!represented.includes(x)):[];
  console.log('[PDF_FAST_FIRST_PASS]',filename,'rows',all.length,'represented',represented.join(','),'missing',missing.join(','));

  // Retry ONLY missing pages. Gemini remains primary; OpenAI can recover a missing page when Gemini is unavailable.
  for(const page of missing){
    let rows=[], lastErr=null;
    for(let attempt=1;attempt<=2;attempt++){
      try{
        const pp=`Read ONLY PDF page ${page}. Ignore all other pages. Return EVERY legible printed data row from page ${page} only.\nReturn ONLY:\nROW|${page}|item number|exact identifier|exact designation/description|quantity|unit|remarks\nPreserve identifiers exactly. Leave absent fields empty. Never invent. If there are truly no data rows output NO_ROWS.`;
        const pb={contents:[{parts:[{text:pp},{inline_data:{mime_type:mime,data:bytes.toString('base64')}}]}],generationConfig:{maxOutputTokens:16384}};
        const pgx=await geminiOnlyGenerateWithFallbackV8110(pb,90000);
        const pj=await pgx.response.json(), ptxt=(pj.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('').trim();
        rows=parseRows(ptxt,page);
        console.log('[PDF_MISSING_PAGE_RETRY]',filename,'page',page,'attempt',attempt,'rows',rows.length,pgx.model);
        if(rows.length||/\bNO_ROWS\b/i.test(ptxt)){pageStats.push({page,status:rows.length?'OK':'NO_ROWS',rows:rows.length,provider:'GEMINI',model:pgx.model});break;}
        lastErr=new Error('No structured rows/status');
      }catch(e){
        lastErr=e;console.error('[PDF_MISSING_PAGE_FAIL]',filename,'page',page,'attempt',attempt,e?.message||e);
        if(OPENAI_ENABLED){
          try{
            const opp=`Read ONLY PDF page ${page}. Ignore all other pages. Return EVERY legible printed data row from page ${page} only. Return ONLY lines: ROW|${page}|item number|exact identifier|exact designation/description|quantity|unit|remarks. Preserve identifiers exactly. Leave absent fields empty. Never invent. If truly no rows output NO_ROWS.`;
            const ox=await openAIPdfExtractV8131(bytes,mime,opp,90000);
            rows=parseRows(ox.text,page);
            console.log('[PDF_MISSING_PAGE_OPENAI_OK]',filename,'page',page,'rows',rows.length,ox.model);
            if(rows.length||/\bNO_ROWS\b/i.test(ox.text)){pageStats.push({page,status:rows.length?'OK':'NO_ROWS',rows:rows.length,provider:'OPENAI',model:ox.model});break;}
          }catch(oe){lastErr=oe;console.error('[PDF_MISSING_PAGE_OPENAI_FAIL]',filename,'page',page,oe?.message||oe);}
        }
      }
    }
    if(rows.length) all.push(...rows);
    else if(!pageStats.some(x=>x.page===page)) pageStats.push({page,status:'NEEDS_REVIEW',rows:0,error:String(lastErr?.message||'No rows')});
  }

  const clean=all.filter((x,i,a)=>{const k=[x.page,x.item_no,x.identifier,x.description,x.quantity,x.unit].join('|').toLowerCase();return a.findIndex(y=>[y.page,y.item_no,y.identifier,y.description,y.quantity,y.unit].join('|').toLowerCase()===k)===i;});
  if(!clean.length) throw new Error('Gemini PDF extraction returned zero rows');
  represented=[...new Set(clean.map(x=>Number(x.page)).filter(Boolean))].sort((a,b)=>a-b);
  const reviewed=expected?Array.from({length:expected},(_,i)=>i+1).filter(x=>!represented.includes(x) && !pageStats.some(y=>y.page===x&&y.status==='NO_ROWS')):[];
  console.log('[PDF_COMPLETENESS]',filename,'expected',expected||'unknown','represented',represented.join(','),'needsReview',reviewed.join(','));
  const preview=clean.map(x=>[x.page&&`P${x.page}`,x.item_no,x.identifier,x.description,x.quantity,x.unit,x.remarks].filter(Boolean).join(' | ')).join('\n');
  return {document_type:'DRAWING_LIST',detected_languages:['English'],document_summary:reviewed.length?`Partial drawing/reference extraction (${clean.length} rows). Pages needing review: ${reviewed.join(', ')}.`:`Drawing/reference list extracted with Gemini (${clean.length} rows).`,full_text:preview,review_text_english:preview,extracted_items:clean,records:[],page_extraction_status:pageStats,expected_pages:expected,pages_with_rows:represented,needs_review_pages:reviewed,completeness_warning:reviewed.length?`Pages needing review: ${reviewed.join(', ')}`:null,needs_review:reviewed.length>0,_extraction_mode:'GEMINI_90S_PRIMARY_OPENAI_QUALITY_FALLBACK'};
}


async function withTiffTempV8136(bytes,fn){
  const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),crypto=await import('node:crypto');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lmmm-tiff-')); const file=path.join(dir,`src-${crypto.randomUUID()}.tiff`);
  try{await fs.writeFile(file,bytes); return await fn(file);} finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
async function runImageMagickV8137(cmd,args,timeout=60000,maxOut=8*1024*1024){
  const {spawn}=await import('node:child_process');
  const guarded=['-limit','thread','1','-limit','memory','80MiB','-limit','map','128MiB','-limit','area','32MP','-limit','disk','2GiB',...args];
  const env={...process.env,MAGICK_MEMORY_LIMIT:'80MiB',MAGICK_MAP_LIMIT:'128MiB',MAGICK_AREA_LIMIT:'32MP',MAGICK_DISK_LIMIT:'2GiB',MAGICK_THREAD_LIMIT:'1',MAGICK_TEMPORARY_PATH:process.env.MAGICK_TEMPORARY_PATH||'/tmp'};
  return await new Promise((resolve,reject)=>{const cp=spawn(cmd,guarded,{stdio:['ignore','pipe','pipe'],env});const out=[],err=[];let size=0,errSize=0,done=false;
    const finish=(e,v)=>{if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve(v)};
    const timer=setTimeout(()=>{cp.kill('SIGKILL');finish(new Error(`${cmd} timeout`));},timeout);
    cp.stdout.on('data',d=>{size+=d.length;if(size>maxOut){cp.kill('SIGKILL');finish(new Error('Converted TIFF page exceeded memory-safe output limit'));}else out.push(d)});
    cp.stderr.on('data',d=>{if(errSize<65536){err.push(d);errSize+=d.length;}});cp.on('error',e=>finish(e));
    cp.on('close',code=>code===0?finish(null,Buffer.concat(out)):finish(new Error(`${cmd} failed ${code}: ${Buffer.concat(err).toString().slice(0,500)}`)));
  });
}
async function tiffPageCountV8137(file,maxPages=250){
  const fs=await import('node:fs/promises'); const fh=await fs.open(file,'r');
  try{
    const h=Buffer.alloc(16); const hr=await fh.read(h,0,16,0); if(hr.bytesRead<8) throw new Error('TIFF header too short');
    const order=h.toString('ascii',0,2),le=order==='II'; if(!le&&order!=='MM')throw new Error('Invalid TIFF byte order');
    const u16=(b,o)=>le?b.readUInt16LE(o):b.readUInt16BE(o),u32=(b,o)=>le?b.readUInt32LE(o):b.readUInt32BE(o); const magic=u16(h,2);let off=0,count=0;
    if(magic===42){off=u32(h,4);while(off&&count<maxPages){const b=Buffer.alloc(2);if((await fh.read(b,0,2,off)).bytesRead<2)break;const n=u16(b,0),next=off+2+n*12,nx=Buffer.alloc(4);if((await fh.read(nx,0,4,next)).bytesRead<4)break;off=u32(nx,0);count++;}}
    else if(magic===43){if(u16(h,4)!==8)throw new Error('Unsupported BigTIFF offset size');const u64=(b,o)=>Number(le?b.readBigUInt64LE(o):b.readBigUInt64BE(o));off=u64(h,8);while(off&&count<maxPages){const b=Buffer.alloc(8);if((await fh.read(b,0,8,off)).bytesRead<8)break;const n=u64(b,0),next=off+8+n*20,nx=Buffer.alloc(8);if((await fh.read(nx,0,8,next)).bytesRead<8)break;off=u64(nx,0);count++;}}
    else throw new Error(`Unsupported TIFF magic ${magic}`);
    return {total:Math.max(1,count),capped:count>=maxPages};
  }finally{await fh.close();}
}
async function tiffOnePageJpegV8137(file,page){
  // Keep decoded pixels out of Node heap. ImageMagick may spill its pixel cache to /tmp.
  // 2 GiB disk cache is intentional: scanned engineering TIFF pages can require far more cache
  // than their compressed file size while RAM remains capped well below Render's 512 MiB limit.
  try{
    return await runImageMagickV8137('convert',[`${file}[${page-1}]`,'-background','white','-alpha','remove','-colorspace','sRGB','-resize','1100x1100>','-strip','-quality','68','jpeg:-'],120000,5*1024*1024);
  }catch(e){
    if(!/cache resources exhausted|OpenPixelCache/i.test(String(e?.message||e))) throw e;
    console.warn('[TIFF_CACHE_RETRY]',page,'retrying with smaller output and disk-backed cache');
    return await runImageMagickV8137('convert',[`${file}[${page-1}]`,'-background','white','-alpha','remove','-colorspace','Gray','-resize','850x850>','-strip','-quality','60','jpeg:-'],120000,4*1024*1024);
  }
}
function parseDelimitedRowsV8133(txt,forcedPage=null){
  const rows=[]; let docType='TECHNICAL_REFERENCE',title='Technical reference document';
  for(const raw of String(txt||'').split(/\r?\n/)){
    const line=raw.trim();
    if(/^DOC\|/i.test(line)){const p=line.split('|');docType=(p[1]||docType).trim().toUpperCase().replace(/\s+/g,'_');title=(p.slice(2).join('|')||title).trim();continue;}
    if(!/^ROW\|/i.test(line))continue; const p=line.split('|');
    rows.push({page:String(forcedPage||Number(String(p[1]||'').replace(/\D/g,''))||'')||null,item_no:(p[2]||'').trim()||null,identifier:(p[3]||'').trim()||null,description:(p[4]||'').trim()||null,quantity:(p[5]||'').trim()||null,unit:(p[6]||'').trim()||null,remarks:(p.slice(7).join('|')||'').trim()||null});
  }
  return {rows,docType,title};
}
async function openAIImageBatchV8133(batch,filename,caption,timeoutMs=150000){
  if(!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
  const prompt=`Classify and extract these consecutive pages from one LMMM industrial source. Filename: ${filename}. Caption: ${caption||'(none)'}.
First line MUST be DOC|<MANUAL|PARTS_LIST|DRAWING_LIST|EQUIPMENT_DATA|JOB|HISTORY|DEFECT|FORMAT|PERMIT|BOQ|LOGBOOK|INSPECTION|TECHNICAL_REFERENCE|OTHER>|<short factual title based on heading/content>.
Then extract EVERY legible row/maintenance line as ROW|page|item no|exact identifier|exact description/designation|quantity|unit|remarks.
Preserve exact IDs, drawing/part numbers, dates and quantities. Do not guess. Do not copy filename numbers into data fields. Unreadable=[UNREADABLE].`;
  const content=[{type:'input_text',text:prompt}];
  for(const p of batch){content.push({type:'input_text',text:`SOURCE PAGE ${p.page}`});content.push({type:'input_image',image_url:`data:image/jpeg;base64,${p.bytes.toString('base64')}`,detail:'high'});}
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  try{const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:ctrl.signal,headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:OPENAI_MODEL,input:[{role:'user',content}],max_output_tokens:16384})});
    if(!r.ok)throw new Error(`OpenAI TIFF ${r.status}: ${(await r.text()).slice(0,700)}`);const j=await r.json();const text=String(j.output_text||'')||(j.output||[]).flatMap(o=>o.content||[]).map(c=>c.text||'').join('\n');if(!text.trim())throw new Error('OpenAI TIFF empty response');return {text,provider:'OPENAI',model:j.model||OPENAI_MODEL};
  }catch(e){if(e?.name==='AbortError'){const x=new Error('OpenAI TIFF timeout');x.code='OPENAI_TIMEOUT';throw x;}throw e;}finally{clearTimeout(timer);}
}
async function openRouterImageBatchV8134(batch,filename,caption,timeoutMs=90000){
  if(!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing');
  const prompt=`Classify and extract these consecutive pages from one LMMM industrial source. Filename: ${filename}. Caption: ${caption||'(none)'}. First line DOC|<MANUAL|PARTS_LIST|DRAWING_LIST|EQUIPMENT_DATA|JOB|HISTORY|DEFECT|FORMAT|PERMIT|BOQ|LOGBOOK|INSPECTION|TECHNICAL_REFERENCE|OTHER>|<short factual title>. Then EVERY legible row as ROW|page|item no|exact identifier|exact description/designation|quantity|unit|remarks. Preserve exact values; never guess.`;
  const content=[{type:'text',text:prompt}];
  for(const p of batch){content.push({type:'text',text:`SOURCE PAGE ${p.page}`});content.push({type:'image_url',image_url:{url:`data:image/jpeg;base64,${p.bytes.toString('base64')}`}});}
  const r=await geminiFetchV890('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${OPENROUTER_API_KEY}`,'Content-Type':'application/json','X-Title':'LMMM AI Maintenance'},body:JSON.stringify({model:process.env.OPENROUTER_FREE_VISION_MODEL||'openrouter/free',messages:[{role:'user',content}],max_tokens:16384})},timeoutMs);
  if(!r.ok) throw new Error(`OpenRouter TIFF ${r.status}: ${(await r.text()).slice(0,600)}`);
  const j=await r.json(),text=j?.choices?.[0]?.message?.content;if(!text)throw new Error('OpenRouter TIFF empty response');return {text,provider:'OPENROUTER',model:j.model||'openrouter/free'};
}
async function geminiImageBatchV8133(batch,filename,caption){
  const prompt=`Classify and extract these consecutive pages from one LMMM industrial source. Filename: ${filename}. Caption: ${caption||'(none)'}.
First line DOC|<MANUAL|PARTS_LIST|DRAWING_LIST|EQUIPMENT_DATA|JOB|HISTORY|DEFECT|FORMAT|PERMIT|BOQ|LOGBOOK|INSPECTION|TECHNICAL_REFERENCE|OTHER>|<short factual title based on heading/content>.
Then EVERY legible row as ROW|page|item no|exact identifier|exact description/designation|quantity|unit|remarks. Preserve exact source values; never guess.`;
  const parts=[{text:prompt}]; for(const p of batch){parts.push({text:`SOURCE PAGE ${p.page}`});parts.push({inline_data:{mime_type:'image/jpeg',data:p.bytes.toString('base64')}});}
  const gx=await geminiOnlyGenerateWithFallbackV8110({contents:[{parts}],generationConfig:{maxOutputTokens:16384}},120000);const j=await gx.response.json();return {text:(j.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join(''),provider:'GEMINI',model:gx.model};
}
async function extractLargeTiffV8133(bytes,mime,filename,caption){
  return await withTiffTempV8136(bytes,async file=>{
    const {total,capped}=await tiffPageCountV8137(file,250); console.log('[TIFF_PAGES]',filename,total,'mode=DISK_CACHE_ONE_PAGE','capped=',capped);
    const all=[],stats=[]; let docType='TECHNICAL_REFERENCE',title='Technical reference document';
    // Render free instance has 512 MiB RAM. One TIFF page at a time prevents decompressed multi-frame accumulation.
    for(let page=1;page<=total;page++){
      let jpg=null,out=null,last=null;
      try{
        jpg=await tiffOnePageJpegV8137(file,page); const batch=[{page,bytes:jpg,mime:'image/jpeg'}];
        if(GEMINI_API_KEY){try{out=await geminiImageBatchV8133(batch,filename,caption);console.log('[TIFF_PAGE_OK] GEMINI',page);}catch(e){last=e;console.error('[TIFF_PAGE_FAIL] GEMINI',page,e.message);}}
        if(!out&&OPENROUTER_API_KEY){try{out=await openRouterImageBatchV8134(batch,filename,caption);console.log('[TIFF_PAGE_OK] OPENROUTER_FREE',page);}catch(e){last=e;console.error('[TIFF_PAGE_FAIL] OPENROUTER_FREE',page,e.message);}}
        if(!out){stats.push({page,status:'NEEDS_REVIEW',rows:0,error:String(last?.message||'AI unavailable')});continue;}
        const parsed=parseDelimitedRowsV8133(out.text,page); if(page===1){docType=parsed.docType||docType;title=parsed.title||title;} all.push(...parsed.rows);
        stats.push({page,status:parsed.rows.length?'OK':'NO_ROWS',rows:parsed.rows.length,provider:out.provider,model:out.model});
      }catch(e){console.error('[TIFF_PAGE_ERROR]',page,e.message);stats.push({page,status:'NEEDS_REVIEW',rows:0,error:String(e.message||e)});}
      finally{jpg=null;}
    }
    const clean=all.filter((x,i,a)=>{const k=[x.page,x.item_no,x.identifier,x.description,x.quantity,x.unit].join('|').toLowerCase();return a.findIndex(y=>[y.page,y.item_no,y.identifier,y.description,y.quantity,y.unit].join('|').toLowerCase()===k)===i;});
    const review=stats.filter(x=>x.status==='NEEDS_REVIEW').map(x=>x.page); if(!clean.length)throw new Error(`TIFF extraction returned zero rows; pages retained for retry (${review.join(',')||'all'})`);
    const preview=clean.map(x=>[x.page&&`P${x.page}`,x.item_no,x.identifier,x.description,x.quantity,x.unit,x.remarks].filter(Boolean).join(' | ')).join('\n');
    return {document_type:docType,detected_languages:['English'],document_summary:`${title}. ${total}-page TIFF; ${clean.length} extracted items${review.length?`; pages needing review: ${review.join(', ')}`:''}.`,full_text:preview,review_text_english:preview,extracted_items:clean,records:[],expected_pages:total,page_extraction_status:stats,needs_review_pages:review,needs_review:review.length>0,_provider:'FREE_MULTI_PROVIDER',_extraction_mode:'TIFF_ADAPTIVE_DISK_CACHE_V8138'};
  });
}

async function extractPlainTechnicalV891(bytes,mime,filename,caption){
  if(!GEMINI_API_KEY && !GROQ_API_KEY && !OPENROUTER_API_KEY && !OPENAI_ENABLED) throw new Error('No enabled AI provider key configured');
  const prompt=`You are a document transcription engine, not a conversational assistant.
Read the ENTIRE uploaded industrial document, including every available PDF page.
Return ONLY data lines. Never explain your work, never repeat these instructions, never say "and so on", "wait", or "let's".
If clearly unrelated to industrial plant/maintenance knowledge, output only: UNRELATED
Otherwise output:
DOC|<document type>|<short factual title>
For EVERY legible drawing/part/BOQ/list row output exactly:
ROW|<page>|<item number if printed>|<exact drawing/part/identifier>|<exact designation/description>|<quantity if printed>|<unit if printed>|<remarks if printed>
If a field is absent leave it empty between separators.
Preserve identifiers character-for-character. Do not invent values. Continue until all available pages are processed.`;
  const body={contents:[{parts:[{text:prompt},{inline_data:{mime_type:mime,data:bytes.toString('base64')}}]}],
    generationConfig:{maxOutputTokens:8192}};
  const gx=await geminiGenerateWithFallbackV892(body,60000),r=gx.response;
  console.log('[AI_USED]',gx.provider||'GEMINI',gx.model,'delimited-full-document');
  const j=await r.json(),txt=(j.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('').trim();
  if(!txt) throw new Error('Delimited extraction returned empty output');
  if(/^UNRELATED\b/i.test(txt)) return {document_type:'UNRELATED',detected_languages:[],document_summary:'Unrelated to LMMM plant / maintenance knowledge.',full_text:'',review_text_english:'',extracted_items:[],records:[]};
  const rows=[]; let docType='TECHNICAL_REFERENCE',title='Technical reference document';
  for(const raw of txt.split(/\r?\n/)){
    const line=raw.trim();
    if(/^DOC\|/i.test(line)){const p=line.split('|');docType=(p[1]||docType).trim().toUpperCase().replace(/\s+/g,'_');title=(p.slice(2).join('|')||title).trim();continue;}
    if(!/^ROW\|/i.test(line)) continue;
    const p=line.split('|');
    rows.push({page:(p[1]||'').trim()||null,item_no:(p[2]||'').trim()||null,identifier:(p[3]||'').trim()||null,description:(p[4]||'').trim()||null,quantity:(p[5]||'').trim()||null,unit:(p[6]||'').trim()||null,remarks:(p.slice(7).join('|')||'').trim()||null});
  }
  if(!rows.length) throw new Error('No structured rows were returned from technical reference');
  const cleanRows=rows.filter((x,i,a)=>{
    const k=[x.page,x.item_no,x.identifier,x.description,x.quantity,x.unit].join('|').toLowerCase();
    return a.findIndex(y=>[y.page,y.item_no,y.identifier,y.description,y.quantity,y.unit].join('|').toLowerCase()===k)===i;
  });
  const preview=cleanRows.map(x=>[x.page&&`P${x.page}`,x.item_no,x.identifier,x.description,x.quantity,x.unit,x.remarks].filter(Boolean).join(' | ')).join('\n');
  return {document_type:docType,detected_languages:['English'],document_summary:title,full_text:preview,review_text_english:preview,extracted_items:cleanRows,records:[],_extraction_mode:'DELIMITED_FULL_DOCUMENT'};
}

function isTiffSourceV8135(bytes,mime='',filename=''){
  const b=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes||[]);
  const magic=b.length>=4 && ((b[0]===0x49&&b[1]===0x49&&b[2]===0x2a&&b[3]===0x00)||(b[0]===0x4d&&b[1]===0x4d&&b[2]===0x00&&b[3]===0x2a));
  return magic || /tiff/i.test(String(mime||'')) || /\.tiff?$/i.test(String(filename||''));
}
async function extractMaintenanceV874(bytes,mime,filename,caption){
  if(/pdf/i.test(String(mime||''))){
    return await extractPdfBatchesV897(bytes,mime,filename,caption);
  }
  if(isTiffSourceV8135(bytes,mime,filename)){
    console.log('[TIFF_ROUTE]',filename,mime,'magic-or-metadata');
    return await extractLargeTiffV8133(bytes,mime,filename,caption);
  }
  if(/image/i.test(String(mime||''))) return await extractPlainTechnicalV891(bytes,mime,filename,caption);
  try{return await extractMaintenanceCoreV887(bytes,mime,filename,caption,false);}
  catch(e){console.error('[EXTRACT_PRIMARY]',e);return await extractMaintenanceCoreV887(bytes,mime,filename,caption,true);}
}

function ingestPackV878(p){
  const raw=Array.isArray(p?.extracted_rows)?p.extracted_rows:[];
  if(raw.length===1 && raw[0] && raw[0].__v878_pack) return raw[0].__v878_pack;
  return {document_type:'OTHER',detected_languages:[],document_summary:'',full_text:'',review_text_english:'',extracted_items:[],records:raw};
}
function packForDBV878(pack){return [{__v878_pack:pack}];}
function ingestPreviewV877(packOrRows,filename){
  const pack=Array.isArray(packOrRows)?{document_type:'OTHER',detected_languages:[],document_summary:'',full_text:'',extracted_items:[],records:packOrRows}:packOrRows;
  const rows=Array.isArray(pack.records)?pack.records:[];
  const recordReview=rows.filter(x=>String(x.confidence||'').toUpperCase()==='NEEDS_REVIEW'||(!x.equipment && !['DRAWING_DOCS','MANUAL_REFERENCE'].includes(String(x.module||'').toUpperCase()))).length;
  const reviewPages=Array.isArray(pack.needs_review_pages)?pack.needs_review_pages.length:0;
  const review=recordReview+reviewPages;
  const lines=rows.slice(0,5).map((x,i)=>`${i+1}. ${String(x.module||'NEEDS_REVIEW').toUpperCase()} | ${x.equipment||'Equipment: not confirmed'} | ${x.event_date||'Date: not confirmed'}\n${String(x.description||'-').slice(0,220)}`);
  const items=Array.isArray(pack.extracted_items)?pack.extracted_items.length:0;
  return `File identified & extracted — NOT STORED\nSource: ${filename}\nFile Type: ${pack.document_type||'OTHER'}\nLanguage: ${(pack.detected_languages||[]).join(', ')||'Not confirmed'}\nRecords: ${rows.length} | Detailed items: ${items}\nNeeds Review: ${review}\n\n${String(pack.document_summary||'').slice(0,700)}`;
}
async function setPendingIngestSessionV877(from,id){
  await pool.query(`INSERT INTO ui_sessions(whatsapp_number,session_key,session_value,updated_at) VALUES($1,'PENDING_FILE_INGEST',$2::jsonb,now()) ON CONFLICT(whatsapp_number,session_key) DO UPDATE SET session_value=EXCLUDED.session_value,updated_at=now()`,[normWA(from),JSON.stringify({id})]);
}
async function getPendingIngestV877(from){
  const s=await pool.query(`SELECT session_value FROM ui_sessions WHERE whatsapp_number=$1 AND session_key='PENDING_FILE_INGEST'`,[normWA(from)]);
  const id=s.rows[0]?.session_value?.id;if(!id)return null;
  return (await pool.query(`SELECT * FROM pending_file_ingests WHERE id=$1 AND submitted_by_whatsapp=$2 AND status='PENDING_CONFIRMATION'`,[id,normWA(from)])).rows[0]||null;
}
async function clearPendingIngestV877(from,id,status='DISCARDED'){
  if(id)await pool.query(`UPDATE pending_file_ingests SET status=$2,updated_at=now() WHERE id=$1`,[id,status]);
  await pool.query(`DELETE FROM ui_sessions WHERE whatsapp_number=$1 AND session_key='PENDING_FILE_INGEST'`,[normWA(from)]);
}
async function showIngestOptionsV877(from,p){
  const pack=ingestPackV878(p);
  await sendText(from,ingestPreviewV877(pack,p.source_filename));
  await sendAdaptiveExtractionPreviewV881(from,p);
  await sendList(from,'Check the extracted data, then choose','Choose',[
    {id:'INGEST_STORE_VERIFIED',title:'Store Data',description:'Store only verified maintenance data'},
    {id:'INGEST_CONVERT',title:'Convert / Export',description:'PDF, Excel, TXT, CSV or JSON'}
  ],'File Action');
}
function adaptivePreviewStatsV881(pack){
  const text=String(pack.review_text_english||pack.full_text||'').trim();
  const items=Array.isArray(pack.extracted_items)?pack.extracted_items:[];
  const records=Array.isArray(pack.records)?pack.records:[];
  // One clean WhatsApp message for small/medium data; large/tabular data becomes a private review PDF.
  const tableHeavy=items.length>8 || records.length>8;
  const pageHint=/\bpages?\b/i.test(String(pack.document_summary||'')) || /DRAWING_LIST|BOQ|SPREADSHEET/.test(String(pack.document_type||''));
  const large=text.length>2600 || tableHeavy || (pageHint && items.length>5);
  return {text,items,records,large};
}
async function sendAdaptiveExtractionPreviewV881(from,p){
  const pack=ingestPackV878(p),st=adaptivePreviewStatsV881(pack);
  if(!st.text && !st.items.length && !st.records.length){
    await sendText(from,'Detailed extraction unavailable. Nothing has been stored.');
    return;
  }
  if(!st.large){
    let body=`EXTRACTED DATA — NOT STORED\n\n${st.text}`;
    if(st.items.length){
      const rows=st.items.slice(0,8).map((x,i)=>`${i+1}. ${x.identifier||x.item_no||''} ${x.description||''}${x.quantity?` | Qty: ${x.quantity}${x.unit?` ${x.unit}`:''}`:''}`.trim()).join('\n');
      if(rows && !st.text.includes(rows)) body+=`\n\n${rows}`;
    }
    await sendText(from,body.slice(0,3800));
    return;
  }
  const pdf=tablePdfV880(pack,p.source_filename);
  const base=String(p.source_filename||'extraction').replace(/\.[^.]+$/,'').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,70)||'extraction';
  await sendText(from,`Extraction complete. This file contains ${st.items.length||st.records.length||'large'} detailed item(s), so I prepared a clean review PDF instead of sending long WhatsApp messages.\n\nNothing is stored until you choose Store Data.`);
  // This PDF is a private preview of the uploader's own submitted file, not a repository/report export.
  await sendGeneratedDocumentV878(from,pdf,`${base}_review.pdf`,'application/pdf');
}
// Project-wide rule:
// - A user may always receive an automatic review PDF generated solely from the file that SAME user just uploaded,
//   even without PDF_REPORT authority, because it is only a private pre-storage verification aid.
// - Any PDF/report generated from stored/retrieved data for any user remains governed by that user's normal authorities/scope.
async function sendFullExtractionV878(from,p){ return sendAdaptiveExtractionPreviewV881(from,p); }
function escPdfV879(v){return String(v??'').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').replace(/[^\x20-\x7E]/g,'?');}
function reportRowsV880(pack){
  const items=Array.isArray(pack.extracted_items)&&pack.extracted_items.length?pack.extracted_items:(pack.records||[]);
  return items.map(x=>x||{});
}
function reportColumnsV880(rows){
  const keys=[...new Set(rows.flatMap(x=>Object.keys(x||{})))];
  const preferred=['item_no','identifier','module','area','equipment','sub_equipment','event_date','event_time','shift','description','quantity','unit','action_taken','status','remarks','confidence'];
  return [...preferred.filter(k=>keys.includes(k)),...keys.filter(k=>!preferred.includes(k))].slice(0,18);
}
function wrapCellV880(v,n){
  const t=String(v??'').replace(/\s+/g,' ').trim(); if(!t)return [''];
  const out=[]; for(let i=0;i<t.length;i+=n)out.push(t.slice(i,i+n)); return out.slice(0,4);
}
function tablePdfV880(pack,source){
  const rows=reportRowsV880(pack),cols=reportColumnsV880(rows);
  const landscape=cols.length>7;
  const W=landscape?792:612,H=landscape?612:792;
  const margin=28, usable=W-margin*2, fontSize=landscape?6.5:7.5, lineH=fontSize+3;
  const widths=cols.map(k=>{
    const k0=String(k).toLowerCase();
    if(/description|remarks|action/.test(k0))return 2.3;
    if(/equipment|identifier|sub_equipment/.test(k0))return 1.5;
    return 1;
  });
  const total=widths.reduce((a,b)=>a+b,0), cw=widths.map(x=>usable*x/total);
  const charCaps=cw.map(w=>Math.max(7,Math.floor(w/(fontSize*0.55))));
  const pages=[]; let current=[];
  const headerH=lineH*2.2, titleH=52, footerH=24;
  let used=titleH+headerH;
  for(const row of rows.length?rows:[{description:pack.document_summary||pack.full_text||'No structured rows'}]){
    const wrapped=cols.map((c,i)=>wrapCellV880(row[c],charCaps[i]));
    const rh=Math.max(lineH*1.5,Math.max(...wrapped.map(x=>x.length))*lineH+5);
    if(used+rh+footerH>H-margin){pages.push(current);current=[];used=titleH+headerH;}
    current.push({row,wrapped,rh});used+=rh;
  }
  if(current.length||!pages.length)pages.push(current);
  const objs=[null],add=x=>(objs.push(x),objs.length-1),catalog=add(''),pagesId=add(''),font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds=[];
  pages.forEach((pg,pi)=>{
    let stream=`BT /F1 11 Tf 1 0 0 1 ${margin} ${H-28} Tm (${escPdfV879('LMMM AI Maintenance - Extracted Data')}) Tj /F1 7 Tf 1 0 0 1 ${margin} ${H-42} Tm (${escPdfV879(`Source: ${source} | Type: ${pack.document_type||'OTHER'} | Page ${pi+1}/${pages.length}`)}) Tj ET `;
    let y=H-titleH;
    // header
    let x=margin;
    cols.forEach((c,i)=>{
      stream+=`${x} ${y-headerH} ${cw[i]} ${headerH} re S BT /F1 ${fontSize} Tf 1 0 0 1 ${x+2} ${y-lineH} Tm (${escPdfV879(String(c).replace(/_/g,' ').toUpperCase())}) Tj ET `;
      x+=cw[i];
    });
    y-=headerH;
    pg.forEach(({wrapped,rh})=>{
      x=margin;
      cols.forEach((c,i)=>{
        stream+=`${x} ${y-rh} ${cw[i]} ${rh} re S `;
        wrapped[i].forEach((ln,j)=>{stream+=`BT /F1 ${fontSize} Tf 1 0 0 1 ${x+2} ${y-lineH*(j+1)} Tm (${escPdfV879(ln)}) Tj ET `;});
        x+=cw[i];
      });
      y-=rh;
    });
    stream+=`BT /F1 7 Tf 1 0 0 1 ${margin} 14 Tm (${escPdfV879(landscape?'Landscape - print ready':'Portrait - print ready')}) Tj ET`;
    const content=add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    const pid=add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
    pageIds.push(pid);
  });
  objs[catalog]=`<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId]=`<< /Type /Pages /Kids [${pageIds.map(x=>`${x} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let out='%PDF-1.4\n',offs=[0];
  for(let i=1;i<objs.length;i++){offs[i]=Buffer.byteLength(out);out+=`${i} 0 obj\n${objs[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(out);out+=`xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for(let i=1;i<objs.length;i++)out+=`${String(offs[i]).padStart(10,'0')} 00000 n \n`;
  out+=`trailer\n<< /Size ${objs.length} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out,'binary');
}
function excelHtmlV879(pack,source){
  const rows=reportRowsV880(pack),keys=reportColumnsV880(rows),landscape=keys.length>7;
  const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const bodyRows=(rows.length?rows:[{description:pack.document_summary||pack.full_text||''}]);
  return `<!doctype html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><style>
  @page { size:${landscape?'landscape':'portrait'}; margin:0.35in; mso-header-data:"&CLMMM AI Maintenance"; mso-footer-data:"&CPage &P of &N"; }
  table{border-collapse:collapse;font-family:Arial,sans-serif;font-size:9pt;width:100%} th,td{border:1px solid #555;padding:4px;vertical-align:top;white-space:normal} th{font-weight:bold;text-align:center} .title{font-size:14pt;font-weight:bold;border:0}.meta{font-size:9pt;border:0}
  </style><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Extracted Data</x:Name><x:WorksheetOptions><x:Print><x:ValidPrinterInfo/><x:PaperSizeIndex>9</x:PaperSizeIndex><x:HorizontalResolution>600</x:HorizontalResolution><x:VerticalResolution>600</x:VerticalResolution></x:Print><x:Selected/><x:FreezePanes/><x:FrozenNoSplit/><x:SplitHorizontal>3</x:SplitHorizontal><x:TopRowBottomPane>3</x:TopRowBottomPane><x:FitToPage/><x:Print><x:FitWidth>1</x:FitWidth><x:FitHeight>0</x:FitHeight></x:Print></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body>
  <table><tr><td class="title" colspan="${Math.max(keys.length,1)}">LMMM AI Maintenance - Extracted Data</td></tr><tr><td class="meta" colspan="${Math.max(keys.length,1)}">Source: ${esc(source)} | Type: ${esc(pack.document_type||'OTHER')} | Orientation: ${landscape?'Landscape':'Portrait'}</td></tr>
  <thead><tr>${keys.map(k=>`<th>${esc(k.replace(/_/g,' ').toUpperCase())}</th>`).join('')}</tr></thead><tbody>${bodyRows.map(r=>`<tr>${keys.map(k=>`<td>${esc(r?.[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
}
function xmlEscV882(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');}
function colNameV882(n){let x=n+1,r='';while(x){x--;r=String.fromCharCode(65+(x%26))+r;x=Math.floor(x/26);}return r;}
function crc32V882(buf){
  let c=0xffffffff;
  for(const b of buf){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}
  return (c^0xffffffff)>>>0;
}
function zipStoreV882(files){
  const locals=[],centrals=[];let offset=0;
  for(const [name,data0] of files){
    const data=Buffer.isBuffer(data0)?data0:Buffer.from(data0,'utf8'),nb=Buffer.from(name,'utf8'),crc=crc32V882(data);
    const lh=Buffer.alloc(30);lh.writeUInt32LE(0x04034b50,0);lh.writeUInt16LE(20,4);lh.writeUInt16LE(0x0800,6);lh.writeUInt16LE(0,8);lh.writeUInt16LE(0,10);lh.writeUInt16LE(0,12);lh.writeUInt32LE(crc,14);lh.writeUInt32LE(data.length,18);lh.writeUInt32LE(data.length,22);lh.writeUInt16LE(nb.length,26);lh.writeUInt16LE(0,28);
    locals.push(lh,nb,data);
    const ch=Buffer.alloc(46);ch.writeUInt32LE(0x02014b50,0);ch.writeUInt16LE(20,4);ch.writeUInt16LE(20,6);ch.writeUInt16LE(0x0800,8);ch.writeUInt16LE(0,10);ch.writeUInt16LE(0,12);ch.writeUInt16LE(0,14);ch.writeUInt32LE(crc,16);ch.writeUInt32LE(data.length,20);ch.writeUInt32LE(data.length,24);ch.writeUInt16LE(nb.length,28);ch.writeUInt16LE(0,30);ch.writeUInt16LE(0,32);ch.writeUInt16LE(0,34);ch.writeUInt16LE(0,36);ch.writeUInt32LE(0,38);ch.writeUInt32LE(offset,42);
    centrals.push(ch,nb);offset+=lh.length+nb.length+data.length;
  }
  const central=Buffer.concat(centrals),local=Buffer.concat(locals),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(0,4);end.writeUInt16LE(0,6);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(local.length,16);end.writeUInt16LE(0,20);
  return Buffer.concat([local,central,end]);
}
function nativeXlsxV882(pack,source){
  const rows=reportRowsV880(pack),cols=reportColumnsV880(rows),landscape=cols.length>7;
  const body=rows.length?rows:[{description:pack.document_summary||pack.full_text||''}];
  const all=[cols.map(k=>String(k).replace(/_/g,' ').toUpperCase()),...body.map(r=>cols.map(k=>r?.[k]??''))];
  const maxWidths=cols.map((_,i)=>Math.min(45,Math.max(10,...all.slice(0,300).map(r=>String(r[i]??'').length+2))));
  const cell=(v,ref,style=0)=>{
    if(typeof v==='number'&&Number.isFinite(v))return `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xmlEscV882(v)}</t></is></c>`;
  };
  let sheetRows='';
  all.forEach((r,ri)=>{sheetRows+=`<row r="${ri+1}">${r.map((v,ci)=>cell(v,`${colNameV882(ci)}${ri+1}`,ri===0?1:0)).join('')}</row>`;});
  const lastCol=colNameV882(Math.max(0,cols.length-1));
  const colsXml=maxWidths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('');
  const sheet=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${lastCol}${Math.max(1,all.length)}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${colsXml}</cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:${lastCol}${Math.max(1,all.length)}"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="${landscape?'landscape':'portrait'}" fitToWidth="1" fitToHeight="0" paperSize="9"/><headerFooter><oddHeader>&amp;CLMMM AI Maintenance</oddHeader><oddFooter>&amp;CPage &amp;P of &amp;N</oddFooter></headerFooter></worksheet>`;
  const styles=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="2"><border/><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf></cellXfs></styleSheet>`;
  const files=[
    ['[Content_Types].xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`],
    ['_rels/.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`],
    ['xl/workbook.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Extracted Data" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml',sheet],
    ['xl/styles.xml',styles],
    ['docProps/core.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>LMMM AI Maintenance Extracted Data</dc:title><dc:subject>${xmlEscV882(source)}</dc:subject></cp:coreProperties>`],
    ['docProps/app.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>LMMM AI Maintenance</Application></Properties>`]
  ];
  return zipStoreV882(files);
}

async function exportPendingV878(from,p,kind){
  const pack=ingestPackV878(p),base=String(p.source_filename||'extraction').replace(/\.[^.]+$/,'').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,80)||'extraction';
  const full=`Source: ${p.source_filename}\nType: ${pack.document_type}\nLanguages: ${(pack.detected_languages||[]).join(', ')}\nSummary: ${pack.document_summary||''}\n\nFULL EXTRACTION\n${pack.full_text||''}\n\nSTRUCTURED ITEMS\n${JSON.stringify(pack.extracted_items||[],null,2)}\n\nRECORDS\n${JSON.stringify(pack.records||[],null,2)}`;
  if(kind==='PDF'){await sendGeneratedDocumentV878(from,tablePdfV880(pack,p.source_filename),`${base}_extracted.pdf`,'application/pdf');return;}
  if(kind==='EXCEL'){await sendGeneratedDocumentV878(from,nativeXlsxV882(pack,p.source_filename),`${base}_extracted.xlsx`,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');return;}
  if(kind==='TXT'){await sendGeneratedDocumentV878(from,Buffer.from(full,'utf8'),`${base}_extracted.txt`,'text/plain');return;}
  if(kind==='JSON'){await sendGeneratedDocumentV878(from,Buffer.from(JSON.stringify(pack,null,2),'utf8'),`${base}_extracted.json`,'application/json');return;}
  if(kind==='CSV'){
    const items=Array.isArray(pack.extracted_items)?pack.extracted_items:[];
    const rows=items.length?items:(pack.records||[]);
    const keys=[...new Set(rows.flatMap(x=>Object.keys(x||{})))];
    const ordered=reportColumnsV880(rows);
    const csv='\uFEFF'+[ordered.map(csvCellV878).join(','),...rows.map(x=>ordered.map(k=>csvCellV878(x?.[k])).join(','))].join('\r\n');
    await sendGeneratedDocumentV878(from,Buffer.from(csv,'utf8'),`${base}_extracted_table.csv`,'text/csv; charset=utf-8');return;
  }
}
async function storePendingVerifiedV877(from,p){
  const u=await byWA(from); if(!u||!(await hasAuthorityV874(u,'ENTRY'))){await sendText(from,'Permission denied. ENTRY authority is required to store data.');return;}
  const pack=ingestPackV878(p),rows=Array.isArray(pack.records)?pack.records:[];let saved=0,review=0,dupe=0;
  for(const x of rows){
    const confidence=['HIGH','MEDIUM'].includes(String(x.confidence||'').toUpperCase())?String(x.confidence).toUpperCase():'NEEDS_REVIEW';
    const module=String(x.module||'NEEDS_REVIEW').toUpperCase();
    const referenceDoc=['DRAWING_DOCS','MANUAL_REFERENCE'].includes(module);
    if(confidence==='NEEDS_REVIEW'||(!referenceDoc && !x.equipment)){review++;continue;}
    try{const raw={...x,document_type:pack.document_type,document_summary:pack.document_summary,extracted_items:pack.extracted_items};
      const q=await pool.query(`INSERT INTO maintenance_ingest_records(data_class,source_type,source_media_id,source_filename,source_mime_type,source_caption,source_sha256,submitted_by_employee_number,submitted_by_whatsapp,module,area,equipment,sub_equipment,event_date,event_time,shift,description,action_taken,status,remarks,confidence,raw_extraction) VALUES('TEST','WHATSAPP_FILE',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,$13::time,$14,$15,$16,$17,$18,$19,$20::jsonb) ON CONFLICT DO NOTHING RETURNING id`,[p.source_media_id,p.source_filename,p.source_mime_type,p.source_caption,p.source_sha256,u.employee_number,normWA(from),module,x.area||null,x.equipment||null,x.sub_equipment||null,x.event_date||null,x.event_time||null,x.shift||null,x.description||pack.document_summary||null,x.action_taken||null,x.status||null,x.remarks||null,confidence,JSON.stringify(raw)]);if(q.rowCount)saved++;else dupe++;}catch(e){console.error('[INGEST_STORE]',e.message);review++;}
  }
  if(review){const missing=rows.filter(x=>String(x.confidence||'').toUpperCase()==='NEEDS_REVIEW'||(!x.equipment&&!['DRAWING_DOCS','MANUAL_REFERENCE'].includes(String(x.module||'').toUpperCase()))).slice(0,8).map((x,i)=>`${i+1}. ${x.module||'NEEDS_REVIEW'} — ${!x.equipment?'Equipment missing/uncertain; ':''}${!x.event_date?'Date missing/uncertain; ':''}${x.description||''}`).join('\n');await sendText(from,`Not stored completely because ${review} record(s) need confirmation.\n\n${missing}\n\nSend the correct source-backed details in a simple message, for example:\nEDIT 1 | Equipment=WBF-2 | Date=2026-09-22 | Module=DEFECT\n\nThen choose Store Data again.`);return;}
  await clearPendingIngestV877(from,p.id,'STORED');
  await sendText(from,`✅ Confirmed TEST data stored\nStored: ${saved}\nDuplicates skipped: ${dupe}\nSource: ${p.source_filename}`);
}
async function handlePendingIngestCommandV877(from,cmd){
  if(!/^INGEST_/.test(cmd) && !/^EDIT\s+\d+\s*\|/i.test(cmd))return false;
  const p=await getPendingIngestV877(from);if(!p){await sendText(from,'No pending file extraction. Please send the file again.');return true;}
  const pack=ingestPackV878(p),rows=Array.isArray(pack.records)?pack.records:[];
  if(cmd==='INGEST_STORE_VERIFIED'){await storePendingVerifiedV877(from,p);return true;}
  if(cmd==='INGEST_CONVERT'){
    await sendList(from,'Choose file format','Convert',[
      {id:'INGEST_EXPORT_PDF',title:'PDF',description:'Complete extraction as PDF'},
      {id:'INGEST_EXPORT_EXCEL',title:'Excel',description:'Structured extracted data for Excel'},
      {id:'INGEST_EXPORT_TXT',title:'TXT',description:'Complete extracted text'},
      {id:'INGEST_EXPORT_CSV',title:'CSV',description:'Spreadsheet-friendly extracted data'},
      {id:'INGEST_EXPORT_JSON',title:'JSON',description:'Complete structured extraction'}
    ],'File Conversion');return true;
  }
  if(/^INGEST_EXPORT_(PDF|EXCEL|TXT|CSV|JSON)$/.test(cmd)){
    const kind=cmd.replace('INGEST_EXPORT_','');await exportPendingV878(from,p,kind);
    await sendList(from,'Conversion sent. Store the verified maintenance data only if it is correct.','Choose',[
      {id:'INGEST_STORE_VERIFIED',title:'Store Data',description:'Store verified, complete maintenance data'},
      {id:'INGEST_CONVERT',title:'Convert Again',description:'Choose another output format'}
    ],'Next Action');return true;
  }
  // Backward-compatible handling for old WhatsApp list messages; these are no longer shown in the UI.
  if(cmd==='INGEST_VIEW_FULL'){await sendFullExtractionV878(from,p);return true;}
  if(cmd==='INGEST_READ_ONLY'||cmd==='INGEST_DISCARD'||cmd==='INGEST_REVIEW'){await showIngestOptionsV877(from,p);return true;}
  const m=cmd.match(/^EDIT\s+(\d+)\s*\|\s*(.+)$/i);if(m){
    const idx=Number(m[1])-1;if(idx<0||idx>=rows.length){await sendText(from,'Invalid record number.');return true;}
    const allowed={equipment:'equipment',date:'event_date',module:'module',area:'area','sub-equipment':'sub_equipment',subequipment:'sub_equipment',shift:'shift'};
    for(const part of m[2].split('|')){const z=part.split('=');if(z.length<2)continue;const k=allowed[z[0].trim().toLowerCase()];if(k)rows[idx][k]=z.slice(1).join('=').trim()||null;}
    rows[idx].confidence=(rows[idx].module && rows[idx].module!=='NEEDS_REVIEW' && (rows[idx].equipment || ['DRAWING_DOCS','MANUAL_REFERENCE'].includes(String(rows[idx].module).toUpperCase())))?'MEDIUM':'NEEDS_REVIEW';
    pack.records=rows;await pool.query(`UPDATE pending_file_ingests SET extracted_rows=$2::jsonb,updated_at=now() WHERE id=$1`,[p.id,JSON.stringify(packForDBV878(pack))]);
    await showIngestOptionsV877(from,{...p,extracted_rows:packForDBV878(pack)});return true;
  }
  return false;
}
async function reliabilityEventV8100(row,stage,state,provider=null,error=null){
  await pool.query(`INSERT INTO reliability_events(ingest_id,whatsapp,stage,state,provider,error_text) VALUES($1,$2,$3,$4,$5,$6)`,
    [row?.id||null,row?.submitted_by_whatsapp||null,stage,state,provider,error?String(error).slice(0,1500):null]).catch(e=>console.error('[RELIABILITY_AUDIT]',e));
}
function retryDelayMinutesV8100(n){
  return Math.min(60,Math.max(1,Math.pow(2,Math.min(Number(n||0),5))));
}
async function markRetryV8100(row,stage,error){
  const mins=retryDelayMinutesV8100(row?.retry_count||0);
  await pool.query(`UPDATE pending_file_ingests SET status='RETRY_PENDING',workflow_state=$2,last_error=$3,next_retry_at=now()+($4||' minutes')::interval,locked_at=NULL,updated_at=now() WHERE id=$1`,
    [row.id,`${stage}_RETRY_PENDING`,String(error?.message||error).slice(0,1500),String(mins)]);
  await reliabilityEventV8100(row,stage,'RETRY_PENDING',null,error);
}
async function recoverPendingWorkV8100(){
  // Server restart recovery: release stale locks and make unfinished work retryable.
  await pool.query(`UPDATE pending_file_ingests SET status='RETRY_PENDING',workflow_state='RECOVERED_AFTER_RESTART',locked_at=NULL,next_retry_at=now(),updated_at=now()
    WHERE status='EXTRACTING' AND (locked_at IS NULL OR locked_at < now()-interval '5 minutes')`).catch(e=>console.error('[RECOVERY]',e));
}
async function extractQueuedIngestV895(from,row){
  try{
    await pool.query(`UPDATE pending_file_ingests SET status='EXTRACTING',workflow_state='AI_PROCESSING',locked_at=now(),retry_count=retry_count+1,last_error=NULL,updated_at=now() WHERE id=$1`,[row.id]);
    await reliabilityEventV8100(row,'AI_EXTRACTION','STARTED');
    const bytes=Buffer.from(row.source_bytes||[]);
    if(!bytes.length) throw new Error('Queued source bytes unavailable');
    const pack=await extractMaintenanceV874(bytes,row.source_mime_type||'application/octet-stream',row.source_filename||'upload',row.source_caption||'');
    const strongRefV8125=strongTechnicalReferenceEvidenceV8125(JSON.stringify(pack||{}),row.source_filename||'');
    const sourceIsTiffV8135=isTiffSourceV8135(bytes,row.source_mime_type||'',row.source_filename||'');
    const hasTechnicalPayloadV8135=Array.isArray(pack?.extracted_items)&&pack.extracted_items.length>0;
    if(String(pack.document_type||'').toUpperCase()==='UNRELATED' && (strongRefV8125 || sourceIsTiffV8135 || hasTechnicalPayloadV8135)){
      console.log('[RELEVANCE_GUARD_V8135] AI UNRELATED blocked; source requires technical review',row.source_filename,'tiff=',sourceIsTiffV8135,'rows=',pack?.extracted_items?.length||0);
      pack.document_type=strongRefV8125?'REFERENCE':'TECHNICAL_REFERENCE';
      pack.relevance='UNCERTAIN';
      pack.needs_review=true;
      pack.document_summary=pack.document_summary&& !/unrelated/i.test(pack.document_summary)?pack.document_summary:'Technical source extracted; relevance requires review. No automatic rejection.';
    }
    if(String(pack.document_type||'').toUpperCase()==='UNRELATED' && strongRefV8125){
      console.log('[RELEVANCE_OVERRIDE] Strong drawing/manual/parts technical-reference evidence; AI UNRELATED overridden',row.source_filename);
      pack.document_type='REFERENCE';
      pack.relevance='LMMM_RELEVANT';
    }
    if(String(pack.document_type||'').toUpperCase()==='UNRELATED' && !strongRefV8125){
      await pool.query(`UPDATE pending_file_ingests SET status='UNRELATED',extracted_rows=$2::jsonb,updated_at=now() WHERE id=$1`,[row.id,JSON.stringify(packForDBV878(pack))]);
      await sendText(from,'This upload is not relevant to LMMM plant / maintenance knowledge. Nothing was stored.');
      return true;
    }
    const q=await pool.query(`UPDATE pending_file_ingests SET status='PENDING_CONFIRMATION',workflow_state='CONFIRMATION_PENDING',extracted_rows=$2::jsonb,last_error=NULL,next_retry_at=NULL,locked_at=NULL,extraction_engine_version='V8.13.8',updated_at=now() WHERE id=$1 RETURNING *`,[row.id,JSON.stringify(packForDBV878(pack))]);
    await armTemporarySourceExpiryV8120(row.id);
    await reliabilityEventV8100(row,'AI_EXTRACTION','SUCCEEDED',pack?._provider||null);
    await pool.query(`UPDATE pending_file_ingests SET workflow_state='SOURCE_SECURED',updated_at=now() WHERE id=$1`,[row.id]).catch(()=>{});
    await reliabilityEventV8100(row,'INTAKE','SOURCE_SECURED');
    await setPendingIngestSessionV877(from,row.id);
    await setIngestModeV874(from,false);
    await showIngestOptionsV877(from,q.rows[0]);
    return true;
  }catch(e){
    const msg=String(e?.message||e).slice(0,1500);
    console.error('[QUEUED_EXTRACT]',row.id,e);
    await markRetryV8100(row,'AI_EXTRACTION',e).catch(()=>{});
    await setPendingIngestSessionV877(from,row.id).catch(()=>{});
    // Notify only on the first failure. Automatic retry workers stay silent to avoid annoying duplicate WhatsApp messages.
    if(String(row?.status||'').toUpperCase()!=='RETRY_PENDING') await sendButtons(from,'Source is safely queued. AI is temporarily unavailable; no re-upload needed.',[
      {id:'RETRY_LAST_UPLOAD',title:'Retry Extraction'},
      {id:'INGEST_STATUS',title:'Check Status'}
    ]);
    return false;
  }
}

const TEMP_CONFIRMATION_MINUTES_V8120 = Math.max(1, Number(process.env.UPLOAD_CONFIRMATION_MINUTES || 10));

async function armTemporarySourceExpiryV8120(ingestId){
  if(!ingestId) return;
  await pool.query(`
    UPDATE pending_file_ingests
       SET confirmation_expires_at = NOW() + ($2::text || ' minutes')::interval
     WHERE id=$1
       AND workflow_state='CONFIRMATION_PENDING'
       AND source_bytes IS NOT NULL
  `,[ingestId,TEMP_CONFIRMATION_MINUTES_V8120]);
}


async function purgeConfirmedSourceBytesV8120(ingestId){
  if(!ingestId) return;
  await pool.query(`
    UPDATE pending_file_ingests
       SET source_bytes=NULL,
           source_purged_at=NOW(),
           confirmation_expires_at=NULL
     WHERE id=$1
  `,[ingestId]);
  await reliabilityEventV8100(ingestId,'CLEANUP','CONFIRMED_SOURCE_PURGED',null,'Structured data retained; temporary upload bytes purged');
}

async function purgeExpiredTemporarySourcesV8120(){
  const r=await pool.query(`
    UPDATE pending_file_ingests
       SET source_bytes=NULL,
           source_purged_at=NOW(),
           workflow_state='EXPIRED',
           status='EXPIRED',
           last_error=COALESCE(last_error,'Confirmation window expired; temporary source purged')
     WHERE source_bytes IS NOT NULL
       AND confirmation_expires_at IS NOT NULL
       AND confirmation_expires_at <= NOW()
       AND workflow_state='CONFIRMATION_PENDING'
     RETURNING id
  `);
  for(const row of r.rows){
    await reliabilityEventV8100(row.id,'CLEANUP','SOURCE_PURGED',null,'10-minute confirmation window expired');
  }
  return r.rowCount||0;
}

async function purgeRejectedTemporarySourcesV8120(){
  const r=await pool.query(`
    UPDATE pending_file_ingests
       SET source_bytes=NULL,
           source_purged_at=NOW()
     WHERE source_bytes IS NOT NULL
       AND (
         status IN ('REJECTED','UNRELATED','CANCELLED')
         OR workflow_state IN ('REJECTED','UNRELATED','CANCELLED')
       )
     RETURNING id
  `);
  return r.rowCount||0;
}

async function oneTimeLegacySourceCleanupV8120(){
  // Clears old upload binaries only. Confirmed maintenance/history records live in their own tables and are untouched.
  const r=await pool.query(`
    UPDATE pending_file_ingests
       SET source_bytes=NULL,
           source_purged_at=COALESCE(source_purged_at,NOW())
     WHERE source_bytes IS NOT NULL
       AND created_at < NOW() - INTERVAL '10 minutes'
       AND workflow_state NOT IN ('AI_PROCESSING','EXTRACTING','RETRY_PENDING','SOURCE_SECURED','RECEIVED')
       AND status NOT IN ('RETRY_PENDING','RECEIVED','PROCESSING')
     RETURNING id
  `);
  return r.rowCount||0;
}
async function failSafeWorkerV8100(){
  try{
    await pool.query(`
      UPDATE pending_file_ingests
         SET confirmation_expires_at = NOW() + ($1::text || ' minutes')::interval
       WHERE workflow_state='CONFIRMATION_PENDING'
         AND source_bytes IS NOT NULL
         AND confirmation_expires_at IS NULL
    `,[TEMP_CONFIRMATION_MINUTES_V8120]);
    await purgeExpiredTemporarySourcesV8120();
    await purgeRejectedTemporarySourcesV8120();
  }catch(e){ console.error('[TEMP_CLEANUP_FAIL]',e.message); }

  let lock=false;
  try{
    const lk=await pool.query(`SELECT pg_try_advisory_lock(3518100) AS ok`); lock=!!lk.rows?.[0]?.ok;
    if(!lock) return;
    const q=await pool.query(`SELECT * FROM pending_file_ingests WHERE status='RETRY_PENDING' AND (next_retry_at IS NULL OR next_retry_at<=now()) ORDER BY created_at ASC LIMIT 3`);
    for(const row of q.rows){
      try{await extractQueuedIngestV895(row.submitted_by_whatsapp,row);}
      catch(e){console.error('[FAILSAFE_WORKER_ITEM]',row.id,e);}
    }
  }catch(e){console.error('[FAILSAFE_WORKER]',e);}
  finally{if(lock) await pool.query(`SELECT pg_advisory_unlock(3518100)`).catch(()=>{});}
}
async function retryLastQueuedV895(from){
  const q=await pool.query(`SELECT * FROM pending_file_ingests WHERE submitted_by_whatsapp=$1 AND status IN ('RETRY_PENDING','RECEIVED','EXTRACTING') ORDER BY created_at DESC LIMIT 1`,[normWA(from)]);
  if(!q.rows.length){await sendText(from,'No queued upload is waiting for extraction.');return true;}
  await sendText(from,'Retrying the saved source now…');
  await extractQueuedIngestV895(from,q.rows[0]);
  return true;
}
async function queuedStatusV895(from){
  const q=await pool.query(`SELECT id,source_filename,status,retry_count,last_error,created_at,updated_at FROM pending_file_ingests WHERE submitted_by_whatsapp=$1 ORDER BY created_at DESC LIMIT 1`,[normWA(from)]);
  if(!q.rows.length){await sendText(from,'No recent upload queue found.');return true;}
  const r=q.rows[0];
  await sendText(from,`Upload: ${r.source_filename||'source'}\nStatus: ${r.status}\nAttempts: ${r.retry_count}\nEngine: V8.9.8\nOriginal source: safely queued`);
  return true;
}
async function processMediaMessageV874(from,m){
  try{
    const u=await byWA(from);
    if(!u||u.approval_status!=='approved'||!u.is_active){await sendText(from,'Approved registration required before file processing.');return;}
    const obj=m[m.type]||{},caption=String(obj.caption||'').trim();
    const mediaId=obj.id;if(!mediaId){await sendText(from,'File media ID not available. Please resend.');return;}
    const isAudio=['audio','voice'].includes(m.type);
    await sendText(from,isAudio?'Voice received. Securing source & extracting…':'Received. Source secured; extracting…');
    const d=await downloadWhatsAppMediaV874(mediaId),mime=String(obj.mime_type||d.mime||'application/octet-stream').toLowerCase();
    const guessedExt=isAudio?(String(obj.mime_type||'').includes('mpeg')?'.mp3':String(obj.mime_type||'').includes('mp4')?'.m4a':'.ogg'):'';
    const filename=obj.filename||`${m.type}_${mediaId}${guessedExt}`;
    const crypto=await import('node:crypto'),sha=crypto.createHash('sha256').update(d.bytes).digest('hex');

    // Idempotent queue: same user + same source hash is not duplicated.
    let q=await pool.query(`SELECT * FROM pending_file_ingests WHERE submitted_by_whatsapp=$1 AND source_sha256=$2 ORDER BY created_at DESC LIMIT 1`,[normWA(from),sha]);
    let row=q.rows[0];
    if(!row){
      q=await pool.query(`INSERT INTO pending_file_ingests
        (submitted_by_whatsapp,submitted_by_employee_number,source_media_id,source_filename,source_mime_type,source_caption,source_sha256,source_bytes,extracted_rows,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'RECEIVED') RETURNING *`,
        [normWA(from),u.employee_number,mediaId,filename,mime,caption,sha,d.bytes,JSON.stringify({})]);
      row=q.rows[0];
    }else if(!row.source_bytes){
      q=await pool.query(`UPDATE pending_file_ingests SET source_bytes=$2,source_media_id=$3,status=CASE WHEN status='UNRELATED' THEN status ELSE 'RECEIVED' END,updated_at=now() WHERE id=$1 RETURNING *`,[row.id,d.bytes,mediaId]);
      row=q.rows[0];
    }
    await setPendingIngestSessionV877(from,row.id);
    if(row.status==='PENDING_CONFIRMATION' && row.extracted_rows){
      // Extraction engines evolve; never serve an old cached preview as if it were freshly extracted.
      // Re-run from the durably stored original bytes. The SHA still prevents duplicate source rows.
      q=await pool.query(`UPDATE pending_file_ingests SET status='RECEIVED',extracted_rows='{}'::jsonb,last_error=NULL,next_retry_at=NULL,updated_at=now() WHERE id=$1 RETURNING *`,[row.id]);
      row=q.rows[0];
    }
    if(row.status==='UNRELATED' && row.source_bytes){
      q=await pool.query(`UPDATE pending_file_ingests SET status='RECEIVED',workflow_state='SOURCE_SECURED',extracted_rows='{}'::jsonb,last_error=NULL,next_retry_at=NULL,updated_at=now() WHERE id=$1 RETURNING *`,[row.id]);
      row=q.rows[0];
      console.log('[RELEVANCE_RECHECK] previous UNRELATED source reprocessed with V8.12.6',row.id);
    }
    if(row.status==='UNRELATED'){
      await sendText(from,'This upload is not relevant to LMMM plant / maintenance knowledge. Nothing was stored.'); return;
    }
    await extractQueuedIngestV895(from,row);
  }catch(e){
    console.error('[MEDIA_INGEST]',e);
    await sendText(from,'Upload intake failed before secure queueing. Please resend this source once.');
  }
}

async function processMessage(from,text,payload=''){
  const cmd=String(payload||text||'').trim();
  if(cmd==='RETRY_LAST_UPLOAD' || /^retry( extraction| upload)?$/i.test(cmd)){await retryLastQueuedV895(from);return;}
  if(cmd==='INGEST_STATUS' || /^(upload |extraction )?status$/i.test(cmd)){await queuedStatusV895(from);return;}
  try{await pool.query(`CREATE TABLE IF NOT EXISTS ui_sessions(whatsapp_number TEXT NOT NULL,session_key TEXT NOT NULL,session_value JSONB,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(whatsapp_number,session_key))`);}catch(e){console.error('[SESSION_SCHEMA]',e.message);}
  if(isOwner(from) && /^PURGE_TESTERS$/i.test(cmd)){await sendButtons(from,'Delete all TESTER registrations/profile/contact/roster data? MAIN users and Super Admin are preserved.',[{id:'PURGE_TESTERS_CONFIRM',title:'Confirm Delete'},{id:'BACK',title:'Cancel'}]);return;}
  if(isOwner(from) && cmd==='PURGE_TESTERS_CONFIRM'){const n=await purgeTesterUsersV854(normWA(from));await sendText(from,`✅ Tester cleanup completed.\nTester users removed: ${n}\nMAIN users preserved.`);return;}
  // V8.7.0 Super Admin contact-directory free-text edit continuation.

  // V8.7.2 self-removal has highest user-command priority. Preserve maintenance history/audit data.
  const earlyClean=String(payload||text||'').trim();
  const earlySelfRemove=/^(remove|remov|delete)\s+me[.! ]*$/i.test(earlyClean) || /^(exit|quit|deactivate)[.! ]*$/i.test(earlyClean);
  if(earlyClean==='REMOVE_ME_CONFIRM'){
    const ru=await byWA(from);
    if(!ru){await sendText(from,'You are not registered. Send Hi to register.');return;}
    await sendButtons(from,'Remove your LMMM Maintenance registration? Maintenance history will be preserved.',[{id:'REMOVE_ME_YES',title:'Yes, Remove'},{id:'ACCOUNT_BACK',title:'Cancel'}]);return;
  }
  if(earlyClean==='REMOVE_ME_YES' || earlySelfRemove){
    const ru=await byWA(from);
    if(!ru){await sendText(from,'You are not registered. Send Hi to register.');return;}
    if(earlySelfRemove && earlyClean!=='REMOVE_ME_YES'){await sendButtons(from,'Remove your LMMM Maintenance registration? Maintenance history will be preserved.',[{id:'REMOVE_ME_YES',title:'Yes, Remove'},{id:'ACCOUNT_BACK',title:'Cancel'}]);return;}
    await removeRegistration(ru,normWA(from));
    await sendText(from,'Your registration has been removed. Maintenance history is preserved. Send Hi to re-register.');return;
  }

  // V8.7.0 user contact self-service and natural contact-detail capture.
  // V8.7.0 resilient Super Admin employee lookup.
  if(isOwner(from)){
    const q855=String(text||'').trim(), emp855=/^\d{3,}$/.test(q855);
    const name855=/^[A-Za-z][A-Za-z .'-]{2,50}$/.test(q855)&&!['hi','hello','hey','start','back','search','version'].includes(q855.toLowerCase());
    if(!payload && (emp855||name855)){
      const rr=emp855?(await pool.query('SELECT * FROM users WHERE employee_number=$1 LIMIT 1',[q855])).rows:(await pool.query('SELECT * FROM users WHERE lower(name)=lower($1) ORDER BY employee_number LIMIT 10',[q855])).rows;
      if(rr.length===1){await showUser(from,rr[0]);return;
      }
      if(rr.length>1){await sendList(from,'Employees found','Select',rr.map(u=>({id:`ADM_EMP:${u.employee_number}`,title:u.name,description:`Employee No: ${u.employee_number}`})),'Employee Administration');return;}
      await sendText(from,'Employee not found.');return;
    }
  }
  const selfUser=await byWA(from);
  if(selfUser && selfUser.approval_status==='approved' && selfUser.is_active!==false){
    const t852=String(text||'').trim(), c852=cmd, l852=t852.toLowerCase();
    if(!payload && ['my details','my profile','profile'].includes(l852)){
      await sendButtons(from,'My Details',[{id:'MY_CONTACT',title:'Contact Details'},{id:'MY_ACCESS',title:'Access Details'}]);return;
    }
    if((!payload&&(l852==='contact details'||l852==='my contact'))||c852==='MY_CONTACT'){await sendMyContactV852(from,selfUser);return;}
    if(c852==='MY_ACCESS'){await ensureProfile(selfUser,normWA(from));const pp=(await pool.query('SELECT * FROM user_access_profile WHERE employee_number=$1',[selfUser.employee_number])).rows[0];await sendText(from,`My Access Details\nRole: ${pp?.assigned_role||'-'}\nAccess: ${pp?.access_level||'-'}\nResponsibility: ${pp?.responsibility||'-'}\nAuthorities: ${(pp?.authorities||[]).join(', ')||'-'}`);return;}
    if(/^MYC_(ALT|CMAIL|PMAIL|MAX|EXT|EMER)$/.test(c852)){
      const f=c852.slice(4);
      await pool.query(`INSERT INTO ui_sessions(whatsapp_number,session_key,session_value,updated_at) VALUES($1,'V852_SELF_CONTACT',$2,now())
      ON CONFLICT(whatsapp_number,session_key) DO UPDATE SET session_value=EXCLUDED.session_value,updated_at=now()`,[normWA(from),JSON.stringify({field:f})]);
      const pr={ALT:'Send alternate phone number',CMAIL:'Send company email ID',PMAIL:'Send personal email ID',MAX:'Send MAX number',EXT:'Send office extension',EMER:'Send emergency contact as: Name, Phone'}[f];
      await sendText(from,pr);return;
    }
    const ps=await safeSessionV855(from,'V852_SELF_CONTACT');
    if(ps){
      let st=ps.session_value;if(typeof st==='string'){try{st=JSON.parse(st)}catch{}}
      let patch={};
      if(st?.field==='ALT')patch.alternate_phone_number=cleanPhoneV851(t852);
      if(st?.field==='CMAIL')patch.company_email=cleanEmailV851(t852);
      if(st?.field==='PMAIL')patch.personal_email=cleanEmailV851(t852);
      if(st?.field==='MAX')patch.max_number=t852;
      if(st?.field==='EXT')patch.office_extension=t852;
      if(st?.field==='EMER'){const q=t852.split(',').map(x=>x.trim());patch.emergency_contact_name=q[0];patch.emergency_contact_phone=cleanPhoneV851(q.slice(1).join(','));}
      patch=Object.fromEntries(Object.entries(patch).filter(([,v])=>v));
      if(!Object.keys(patch).length){await sendText(from,'Invalid detail. Please send again.');return;}
      await saveOwnContactPatchV852(selfUser,patch);await pool.query(`DELETE FROM ui_sessions WHERE whatsapp_number=$1 AND session_key='V852_SELF_CONTACT'`,[normWA(from)]);
      await sendText(from,'✅ Contact details updated.');await sendMyContactV852(from,selfUser);return;
    }
    // Natural message, e.g. "my max no 1234, alternate phone 9..., company mail ..."
    if(/\b(max|alternate|alt phone|other phone|company email|personal email|office ext|extension|emergency contact)\b/i.test(t852)){
      const patch=extractContactFieldsV852(t852);
      if(Object.keys(patch).length){await saveOwnContactPatchV852(selfUser,patch);await sendText(from,'✅ Contact details understood and updated.');await sendMyContactV852(from,selfUser);return;}
    }
  }
  // V8.7.0 approved-user employee directory: basic public internal fields only.
  if(!isOwner(from) && selfUser && selfUser.approval_status==='approved' && selfUser.is_active!==false){
    const q853=String(text||'').trim();
    const empQuery=/^\d{3,}$/.test(q853);
    const nameQuery=/^[A-Za-z][A-Za-z .'-]{2,50}$/.test(q853) &&
      !['hi','hello','hey','start','back','search','my account','my details','contact details','profile'].includes(q853.toLowerCase());
    const selfMatch=(empQuery&&q853===String(selfUser.employee_number))||(nameQuery&&q853.toLowerCase()===String(selfUser.name||'').toLowerCase());
    if(selfMatch){
      await ensureProfile(selfUser,normWA(from));
      const me=await byEmp(selfUser.employee_number), pr=(await pool.query('SELECT * FROM user_access_profile WHERE employee_number=$1',[me.employee_number])).rows[0];
      await syncPrimaryContactV851(me,normWA(from));const c=await contactCardV851(me.employee_number);
      await sendText(from,`My Full Details

Name: ${me.name}
Employee No: ${me.employee_number}
Designation: ${me.designation||'-'}
Area: ${me.area_of_working||'-'}
Section: ${me.section_department||'-'}
Shift: ${me.shift||'-'}
Main Phone: ${c?.whatsapp_registration_number||'-'}
Alternate Phone: ${c?.alternate_phone_number||'-'}
Company Email: ${c?.company_email||'-'}
Personal Email: ${c?.personal_email||'-'}
MAX Number: ${c?.max_number||'-'}
Office Extension: ${c?.office_extension||'-'}
Emergency Contact: ${c?.emergency_contact_name||'-'}
Emergency Phone: ${c?.emergency_contact_phone||'-'}
Role: ${pr?.assigned_role||'-'}
Access: ${pr?.access_level||'-'}
Responsibility: ${pr?.responsibility||'-'}
Authorities: ${(pr?.authorities||[]).join(', ')||'-'}`);return;
    }
    if(empQuery||nameQuery){
      let rows;
      if(empQuery) rows=(await pool.query(`SELECT u.name,u.employee_number,u.designation,u.area_of_working,u.section_department,c.whatsapp_registration_number,c.alternate_phone_number,c.company_email,c.personal_email,c.max_number,c.office_extension
        FROM users u LEFT JOIN employee_contact_directory c ON c.employee_number=u.employee_number
        WHERE u.employee_number=$1 AND u.approval_status='approved' AND u.is_active=true LIMIT 1`,[q853])).rows;
      else rows=(await pool.query(`SELECT u.name,u.employee_number,u.designation,u.area_of_working,u.section_department,c.whatsapp_registration_number,c.alternate_phone_number,c.company_email,c.personal_email,c.max_number,c.office_extension
        FROM users u LEFT JOIN employee_contact_directory c ON c.employee_number=u.employee_number
        WHERE lower(u.name)=lower($1) AND u.approval_status='approved' AND u.is_active=true ORDER BY u.employee_number LIMIT 10`,[q853])).rows;
      if(rows.length===1){
        const r=rows[0];
        await sendText(from,`Employee Details

Name: ${r.name}
Employee No: ${r.employee_number}
Designation: ${r.designation||'-'}
Area: ${r.area_of_working||'-'}
Section: ${r.section_department||'-'}
Main Phone: ${r.whatsapp_registration_number||'-'}
Alternate Phone: ${r.alternate_phone_number||'-'}
Company Email: ${r.company_email||'-'}
Personal Email: ${r.personal_email||'-'}
MAX Number: ${r.max_number||'-'}
Office Extension: ${r.office_extension||'-'}`);
        return;
      }
      if(rows.length>1){
        await sendList(from,'Employees found','Select',rows.map(r=>({id:`DIR_EMP:${r.employee_number}`,title:r.name,description:`Employee No: ${r.employee_number}`})),'Employee Directory');return;
      }
      await sendText(from,'Employee not found in approved directory.');return;
    }
    if(/^DIR_EMP:\d+$/.test(cmd)){
      const emp=cmd.split(':')[1],r=(await pool.query(`SELECT u.name,u.employee_number,u.designation,u.area_of_working,u.section_department,c.whatsapp_registration_number,c.alternate_phone_number,c.company_email,c.personal_email,c.max_number,c.office_extension
        FROM users u LEFT JOIN employee_contact_directory c ON c.employee_number=u.employee_number
        WHERE u.employee_number=$1 AND u.approval_status='approved' AND u.is_active=true LIMIT 1`,[emp])).rows[0];
      if(!r){await sendText(from,'Employee not found in approved directory.');return;}
      await sendText(from,`Employee Details

Name: ${r.name}
Employee No: ${r.employee_number}
Designation: ${r.designation||'-'}
Area: ${r.area_of_working||'-'}
Section: ${r.section_department||'-'}
Main Phone: ${r.whatsapp_registration_number||'-'}
Alternate Phone: ${r.alternate_phone_number||'-'}
Company Email: ${r.company_email||'-'}
Personal Email: ${r.personal_email||'-'}
MAX Number: ${r.max_number||'-'}
Office Extension: ${r.office_extension||'-'}`);
      return;
    }
  }
  if(isOwner(from)){
    const cs=await safeSessionV855(from,'V851_CONTACT_EDIT');
    if(cs){
      let st=cs.session_value; if(typeof st==='string'){try{st=JSON.parse(st)}catch{}}
      if(st?.employee_number&&st?.field){
        const emp=String(st.employee_number), raw=String(text||'').trim(); let col=null,val=null,extra=null;
        if(st.field==='ALT'){col='alternate_phone_number';val=cleanPhoneV851(raw);}
        if(st.field==='CMAIL'){col='company_email';val=cleanEmailV851(raw);}
        if(st.field==='PMAIL'){col='personal_email';val=cleanEmailV851(raw);}
        if(st.field==='MAX'){col='max_number';val=raw||null;}
        if(st.field==='EXT'){col='office_extension';val=raw||null;}
        if(st.field==='NOTES'){col='notes';val=raw||null;}
        if(st.field==='EMER'){const parts=raw.split(',').map(x=>x.trim());col='emergency_contact_name';val=parts[0]||null;extra=cleanPhoneV851(parts.slice(1).join(','));}
        if(!val){await sendText(from,'Invalid value. Please send again.');return;}
        const u=await byEmp(emp);if(u)await syncPrimaryContactV851(u,normWA(from));
        if(st.field==='EMER')await pool.query(`UPDATE employee_contact_directory SET emergency_contact_name=$2,emergency_contact_phone=$3,updated_by=$4,updated_at=now() WHERE employee_number=$1`,[emp,val,extra,normWA(from)]);
        else await pool.query(`UPDATE employee_contact_directory SET ${col}=$2,updated_by=$3,updated_at=now() WHERE employee_number=$1`,[emp,val,normWA(from)]);
        await pool.query(`DELETE FROM ui_sessions WHERE whatsapp_number=$1 AND session_key='V851_CONTACT_EDIT'`,[normWA(from)]);
        await sendText(from,`✅ Contact details updated\nEmployee: ${emp}\nOnly Super Admin notified.`);
        await sendContactAdminV851(from,emp);return;
      }
    }
  }
  const clean=String(payload||text||'').trim();
  if(!clean) return;
  if(await handlePendingIngestCommandV877(from,clean)) return;
  if(await adminCommand(from,clean)) return;

  const greeting=/^(hi+|hello+|hey+|start)[.! ]*$/i.test(clean);
  const selfRemove=/^(remove|remov|delete)\s+me[.! ]*$/i.test(clean) || /^(exit|quit|deactivate)[.! ]*$/i.test(clean);
  let u=await byWA(from);

  if(clean==='MENU_ADD'){
    if(!u){await sendText(from,'You are not registered. Send Hi to register.');return;}
    if(!(await hasAuthorityV874(u,'ENTRY'))){await sendText(from,'Permission denied. ENTRY authority is required.');return;}
    await setIngestModeV874(from,true);
    await sendText(from,'Add Entry mode ready. Send maintenance data as PDF, TIFF/image, TXT/CSV, Word, Excel or Access MDB/ACCDB. English/Telugu/Hindi/mixed content is accepted. The file is extracted to a preview first. Nothing is stored until you confirm. Uncertain data stays in Review and is never auto-stored.');return;
  }
  if(clean==='MENU_ACCOUNT'){
    if(!u){await sendText(from,'You are not registered. Send Hi to register.');return;}
    await sendButtons(from,`My Account
Name: ${u.name}
Employee No: ${u.employee_number}
Designation: ${u.designation||'-'}
Area: ${u.area_of_working||'-'}
Section: ${u.section_department||'-'}
Shift: ${u.shift||'-'}`,[{id:'REMOVE_ME_CONFIRM',title:'Remove Me'},{id:'ACCOUNT_BACK',title:'Back'}]); return;
  }
  if(clean==='ACCOUNT_BACK'){
    await sendButtons(from,'How can I help you?',[{id:'MENU_SEARCH',title:'Search'},{id:'MENU_ADD',title:'Add Entry'},{id:'MENU_ACCOUNT',title:'My Account'}]);return;
  }
  if(clean==='REMOVE_ME_CONFIRM'){
    if(!u){await sendText(from,'You are not registered. Send Hi to register.');return;}
    await sendButtons(from,'Remove your LMMM Maintenance registration? Maintenance history will be preserved.',
      [{id:'REMOVE_ME_YES',title:'Yes, Remove'},{id:'ACCOUNT_BACK',title:'Cancel'}]);return;
  }
  if(clean==='REMOVE_ME_YES'){
    if(!u){await sendText(from,'You are not registered. Send Hi to register.');return;}
    await removeRegistration(u,normWA(from));
    await sendText(from,'Your registration has been removed. Maintenance history is preserved. Send Hi to re-register.');return;
  }
  if(selfRemove){
    if(!u){await sendText(from,'You are not registered. Send Hi to register.');return;}
    await removeRegistration(u,normWA(from));
    await sendText(from,'Your LMMM Maintenance registration has been removed. Maintenance history is preserved. Send Hi to re-register.');
    return;
  }
  if(greeting){
    if(!u){await sendText(from,registrationTemplate('Welcome to LMMM Maintenance. Please register:'));return;}
    if(u.approval_status==='pending'){await sendText(from,'Your registration is pending approval.');return;}
    if(u.approval_status==='approved' && u.is_active){
      if(SUPER_ADMINS.has(normWA(from))){await sendButtons(from,'Super Admin • How can I help you?',[{id:'ADM_USERS',title:'User Management'},{id:'MENU_SEARCH',title:'Search'},{id:'MENU_ACCOUNT',title:'My Account'}]);return;}
      await sendButtons(from,'How can I help you?',[{id:'MENU_SEARCH',title:'Search'},{id:'MENU_ADD',title:'Add Entry'},{id:'MENU_ACCOUNT',title:'My Account'}]);return;}
    await sendText(from,registrationTemplate('Re-register for LMMM Maintenance:'));return;
  }
  if(!u){
    const d=parseRegistration(clean);
    if(!d){await sendText(from,registrationTemplate('Please register:'));return;}
    const saved=await saveRegistration(from,d);
    if(!saved.ok){await sendText(from,'This Employee Number is already active. Contact Super Admin.');return;}
    await sendText(from,'Registration submitted. Approval pending.');
    await notifyAdmins(saved.user);
    return;
  }
  if(u.approval_status==='pending'){await sendText(from,'Your registration is pending approval.');return;}
  if(u.approval_status==='approved' && u.is_active){
    await sendText(from,'Registration module is verified. Maintenance modules will be enabled section-by-section after acceptance testing.');
    return;
  }
  await sendText(from,registrationTemplate('Re-register for LMMM Maintenance:'));
}

app.get('/health', async (_req,res)=>{
  try{await pool.query('SELECT 1');res.json({ok:true,version:'8.7.6',phase:'registration',db:true});}
  catch(e){res.status(500).json({ok:false,version:'8.7.6',error:e.message});}
});
app.get('/webhook',(req,res)=>{
  const mode=req.query['hub.mode'], token=req.query['hub.verify_token'], challenge=req.query['hub.challenge'];
  if(mode==='subscribe' && token===VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});
async function claimWhatsAppMessageV8136(m){
  const id=String(m?.id||'').trim(); if(!id) return true;
  try{const q=await pool.query(`INSERT INTO whatsapp_message_dedupe(message_id,whatsapp,message_type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING message_id`,[id,normWA(m.from||''),String(m.type||'')]);return q.rowCount===1;}
  catch(e){console.error('[WA_DEDUPE]',e.message);return true;}
}
async function dispatchWebhookMessageV8136(m){
  if(!(await claimWhatsAppMessageV8136(m))){console.log('[WA_DUPLICATE_IGNORED]',m.id);return;}
  let text='', payload='';
  if(m.type==='text') text=m.text?.body||'';
  else if(m.type==='interactive' && m.interactive?.type==='button_reply'){text=m.interactive.button_reply?.title||'';payload=m.interactive.button_reply?.id||'';}
  else if(m.type==='interactive' && m.interactive?.type==='list_reply'){text=m.interactive.list_reply?.title||'';payload=m.interactive.list_reply?.id||'';}
  else if(['document','image','audio','voice'].includes(m.type)){await processMediaMessageV874(normWA(m.from),m);return;}
  else return;
  await processMessage(normWA(m.from),text,payload);
}
app.post('/webhook',(req,res)=>{
  res.sendStatus(200);
  const entries=req.body?.entry||[];
  for(const e of entries) for(const c of e.changes||[]) for(const m of c.value?.messages||[]){
    dispatchWebhookMessageV8136(m).catch(err=>console.error('[WEBHOOK_MESSAGE]',err));
  }
});

await initDB();
recoverPendingWorkV8100().then(()=>failSafeWorkerV8100()).catch(e=>console.error('[FAILSAFE_STARTUP]',e));
setInterval(()=>failSafeWorkerV8100().catch(e=>console.error('[FAILSAFE_INTERVAL]',e)),60000).unref();


setTimeout(async()=>{
  try{
    const n=await oneTimeLegacySourceCleanupV8120();
    console.log('[V8120_LEGACY_SOURCE_CLEANUP]',n);
  }catch(e){ console.error('[V8120_LEGACY_SOURCE_CLEANUP_FAIL]',e.message); }
},30000);

app.listen(PORT,'0.0.0.0',()=>console.log(`[LMMM] V8.13.8 TIFF ADAPTIVE DISK-CACHE + WEBHOOK IDEMPOTENCY listening on ${PORT}`));
