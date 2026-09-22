// LMMM AI Maintenance V8.5.8
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
  areas:['BDM','BAR MILL','FINISHING','ADDITIONAL AREAS','CRANES','HYDRAULICS','PLANNING'],
  sections:['Operations','Mechanical','Electrical','Instrumentation','ETL','Telecommunications','Water Management','DNW','EnMD','RED']
};
function normKey(v=''){return String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function canonicalArea(v=''){
  const k=normKey(v), m={
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
function accessFromAuthoritiesV858(auth=[]){
 const a=new Set(auth||[]), full=ACCESS_AUTH_V858.FULL_ACCESS.every(x=>a.has(x));
 if(full)return 'FULL_ACCESS';
 if(a.has('EDIT')&&a.has('ENTRY')&&a.has('VIEW'))return 'EDIT';
 if(a.has('ENTRY')&&a.has('VIEW'))return 'ENTRY_VIEW';
 if(a.has('VIEW')&&!a.has('ENTRY'))return 'VIEW_ONLY';
 if(a.has('ENTRY'))return 'ENTRY';
 return a.size?'CUSTOM':'NONE';
}
async function setAccessSyncedV858(emp,access,by){
 const auth=ACCESS_AUTH_V858[access]; if(!auth)throw new Error('Invalid access');
 const u=await byEmp(emp);if(!u)throw new Error('Employee not found');
 await ensureProfile(u,by);
 await pool.query(`UPDATE user_access_profile SET access_level=$2,authorities=$3,assignment_source='SUPER_ADMIN',assigned_by=$4,updated_at=now() WHERE employee_number=$1`,[emp,access,auth,by]);
 await saveAdminOverrideV850(emp,{access_level:access,authorities:auth},by);
}
async function toggleAuthoritySyncedV858(emp,val,by){
 const u=await byEmp(emp);if(!u)throw new Error('Employee not found');await ensureProfile(u,by);
 const r=await pool.query('SELECT authorities FROM user_access_profile WHERE employee_number=$1',[emp]);
 const a=new Set(r.rows[0]?.authorities||[]);a.has(val)?a.delete(val):a.add(val);
 // dependencies: EDIT needs ENTRY+VIEW; advanced capabilities imply VIEW
 if(a.has('EDIT')){a.add('ENTRY');a.add('VIEW');}
 if(['PDF','PRINT_EXPORT','EXCEL','ANALYSIS','REPORTS','ADVANCED_REPORTS','RCM','DELETE_UNDO','APPROVAL'].some(x=>a.has(x)))a.add('VIEW');
 const auth=[...a],access=accessFromAuthoritiesV858(auth);
 await pool.query(`UPDATE user_access_profile SET access_level=$2,authorities=$3,assignment_source='SUPER_ADMIN',assigned_by=$4,updated_at=now() WHERE employee_number=$1`,[emp,access,auth,by]);
 await saveAdminOverrideV850(emp,{access_level:access,authorities:auth},by);
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
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS data_class TEXT NOT NULL DEFAULT 'MAIN'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_data_class ON users(data_class)`);
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
    const r=await pool.query(`INSERT INTO users(whatsapp_number,name,employee_number,designation,area_of_working,section_department,shift,approval_status,is_active,operational_role)
      VALUES($1,$2,$3,$4,$5,$6,$7,'pending',false,'PENDING') RETURNING *`,
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
 await sendText(to,`Contact Details

Name: ${c.name}
Employee No: ${c.employee_number}
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
 const role=o.operational_role||auto.role,access=o.access_level||auto.access,resp=o.responsibility||workResponsibilityV83(fresh),auth=o.authorities?.length?o.authorities:auto.authorities;
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
async function showUser(to,u){
  await ensureProfile(u,normWA(to));
  u=await byEmp(u.employee_number);
  const r=await pool.query('SELECT * FROM user_access_profile WHERE employee_number=$1',[u.employee_number]),p=r.rows[0];
  await sendButtons(to,`Employee Details
Name: ${u.name}
Employee No: ${u.employee_number}
Designation: ${u.designation||'-'}
Area: ${u.area_of_working||'-'}
Section: ${u.section_department||'-'}
Shift: ${u.shift||'-'}${SHIFT_TIMINGS[u.shift]?` (${SHIFT_TIMINGS[u.shift].start}-${SHIFT_TIMINGS[u.shift].end})`:''}
Status: ${u.approval_status}${u.is_active?' / Active':''}

Category/Role: ${p?.assigned_role||'-'}
Access: ${p?.access_level||'-'}
Scope: ${autoAuthorityV83(u).scope}
Responsibility: ${p?.responsibility||'-'}
Authorities: ${(p?.authorities||[]).join(', ')||'-'}
Source: ${p?.assignment_source||'AUTO'}`,
  [{id:`ADM_ASSIGN:${u.employee_number}`,title:'Assign / Change'},{id:`ADM_MORE:${u.employee_number}`,title:'More Options'},{id:'ADM_USERS',title:'Back'}]);
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
  if(text==='ADM_USERS'||/^users?$/i.test(text)){await sendText(from,'User Management\nSearch by Employee No or Name.');return true;}
  if((a=text.match(/^ADM_VIEW:(\d+)$/))){const u=await byEmp(a[1]); if(u)await showUser(from,u);else await sendText(from,'Employee not found.');return true;}
  if((a=text.match(/^ADM_ASSIGN:(\d+)$/))){await sendList(from,'Assign / Change','Select',[
{id:`ADM_CAT:${a[1]}`,title:'Category / Role'},{id:`ADM_DESIG:${a[1]}`,title:'Designation'},{id:`ADM_AREA:${a[1]}`,title:'Area'},{id:`ADM_SECTION:${a[1]}`,title:'Section'},
{id:`ADM_SHIFT:${a[1]}`,title:'Shift'},{id:`ADM_RESP:${a[1]}`,title:'Responsibility'},{id:`ADM_ACCESS:${a[1]}`,title:'Access'},{id:`ADM_AUTH:${a[1]}`,title:'Authorities'},{id:`ADM_CONTACT:${a[1]}`,title:'Contact Details'},{id:`ADM_DATACLASS:${a[1]}`,title:'Tester / Main'}],'Employee Administration');return true;}
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
if((a=text.match(/^ADM_DATACLASS:(\d+)$/))){await sendButtons(from,'Select Data Class',[{id:`SETCLASS:${a[1]}:TESTER`,title:'Tester'},{id:`SETCLASS:${a[1]}:MAIN`,title:'Main'}]);return true;}
if((a=text.match(/^SETCLASS:(\d+):(TESTER|MAIN)$/))){try{const kind=await setDataClassV854(a[1],a[2],normWA(from));await sendText(from,`✅ Data Class changed: ${kind}\nEmployee: ${a[1]}\nOnly Super Admin notified.`);}catch(e){await sendText(from,`Cannot change Data Class: ${e.message}`);}return true;}
if((a=text.match(/^ADM_CAT:(\d+)$/))){await sendButtons(from,'Select Category',[{id:`SETCAT:${a[1]}:CONTRACT_WORKER`,title:'Contract Worker'},{id:`SETCAT:${a[1]}:NON_EXECUTIVE`,title:'Non-Executive'},{id:`SETCAT:${a[1]}:EXECUTIVE`,title:'Executive'}]);return true;}
if((a=text.match(/^SETCAT:(\d+):(CONTRACT_WORKER|NON_EXECUTIVE|EXECUTIVE)$/))){const emp=a[1],cat=a[2];await saveAdminOverrideV850(emp,{category:cat},normWA(from));await sendList(from,`${cat.replaceAll('_',' ')} hierarchy`,'Select',EMPLOYEE_HIERARCHY_V850[cat].map(([code,title])=>({id:`SETDES:${emp}:${code}`,title})),'Designation');await sendText(from,`✅ Category changed: ${cat.replaceAll('_',' ')}\nEmployee: ${emp}\nOnly Super Admin notified.`);return true;}
if((a=text.match(/^ADM_DESIG:(\d+)$/))){await sendButtons(from,'Select Category',[{id:`ADM_CAT:${a[1]}`,title:'Choose Category'}]);return true;}
if((a=text.match(/^SETDES:(\d+):([A-Z_]+)$/))){const emp=a[1],code=a[2];let title=null,cat=null;for(const [c,arr] of Object.entries(EMPLOYEE_HIERARCHY_V850)){const f=arr.find(x=>x[0]===code);if(f){title=f[1];cat=c;break;}}if(!title){await sendText(from,'Designation option not found.');return true;}const d=categoryDefaultAccessV850(cat,title),o=await saveAdminOverrideV850(emp,{category:cat,designation:title,operational_role:d.role,access_level:d.access},normWA(from));const u=await byEmp(emp);if(u)await applyAdminOverrideV850(u,o,normWA(from));await sendText(from,`✅ Designation changed: ${title}\nEmployee: ${emp}\nRole/Access refreshed.\nOnly Super Admin notified.`);return true;}
if((a=text.match(/^ADM_AREA:(\d+)$/))){await sendList(from,'Select Area','Select',LMMM_ORG.areas.map(x=>({id:`SETAREA:${a[1]}:${x.replaceAll(' ','_')}`,title:x})),'Area');return true;}
if((a=text.match(/^SETAREA:(\d+):([A-Z_]+)$/))){const emp=a[1],area=a[2].replaceAll('_',' '),o=await saveAdminOverrideV850(emp,{area,responsibility:null},normWA(from)),u=await byEmp(emp);if(u)await applyAdminOverrideV850(u,o,normWA(from));await sendText(from,`✅ Area changed: ${area}\nEmployee: ${emp}\nResponsibility refreshed.\nOnly Super Admin notified.`);return true;}
if((a=text.match(/^ADM_SECTION:(\d+)$/))){await sendList(from,'Select Section','Select',LMMM_ORG.sections.map(x=>({id:`SETSEC:${a[1]}:${x.replaceAll(' ','_')}`,title:x})),'Section');return true;}
if((a=text.match(/^SETSEC:(\d+):(.+)$/))){const emp=a[1],section=canonicalSection(a[2].replaceAll('_',' ')),o=await saveAdminOverrideV850(emp,{section,responsibility:null},normWA(from)),u=await byEmp(emp);if(u)await applyAdminOverrideV850(u,o,normWA(from));await sendText(from,`✅ Section changed: ${section}\nEmployee: ${emp}\nResponsibility refreshed.\nOnly Super Admin notified.`);return true;}
if((a=text.match(/^ADM_SHIFT:(\d+)$/))){await sendButtons(from,'Select Shift',[{id:`SETSH:${a[1]}:General`,title:'General'},{id:`SETSH:${a[1]}:ROTATING_ABC`,title:'A/B/C Rotating'},{id:`SETSH2:${a[1]}`,title:'Fixed A/B/C'}]);return true;}
if((a=text.match(/^SETSH2:(\d+)$/))){await sendButtons(from,'Fixed Shift',[{id:`SETSH:${a[1]}:A`,title:'A Shift'},{id:`SETSH:${a[1]}:B`,title:'B Shift'},{id:`SETSH:${a[1]}:C`,title:'C Shift'}]);return true;}
if((a=text.match(/^SETSH:(\d+):(General|ROTATING_ABC|A|B|C)$/))){const emp=a[1],shift=a[2],o=await saveAdminOverrideV850(emp,{shift,responsibility:null},normWA(from)),u=await byEmp(emp);if(u)await applyAdminOverrideV850(u,o,normWA(from));await sendText(from,`✅ Shift changed: ${shift}\nEmployee: ${emp}\nOnly Super Admin notified.`);return true;}
  if((a=text.match(/^ADM_MORE:(\d+)$/))){await sendButtons(from,'More user controls',[{id:`ADM_AUTH:${a[1]}`,title:'Authorities'},{id:`ADM_TEST:${a[1]}`,title:'Auto Test'},{id:`ADM_REMOVE:${a[1]}`,title:'Remove User'}]);return true;}
  if((a=text.match(/^ADM_ROLE:(\d+)$/))){await sendButtons(from,'Select Role',[{id:`SR:${a[1]}:NON_EXECUTIVE`,title:'Non-Executive'},{id:`SR:${a[1]}:EXECUTIVE`,title:'Executive'},{id:`SR:${a[1]}:DGM`,title:'DGM'}]);return true;}
  if((a=text.match(/^ADM_ACCESS:(\d+)$/))){await sendList(from,'Select Access','Select',[
{id:`SA:${a[1]}:ENTRY`,title:'Entry Only'},{id:`SA:${a[1]}:VIEW_ONLY`,title:'View Only'},{id:`SA:${a[1]}:ENTRY_VIEW`,title:'Entry + View'},
{id:`SA:${a[1]}:EDIT`,title:'View + Edit / Entry'},{id:`SA:${a[1]}:FULL_ACCESS`,title:'Full Access'}],'Access Level');return true;}
  if((a=text.match(/^ADM_RESP:(\d+)$/))){await sendList(from,'Operational Responsibility','Select',OPERATIONAL_RESPONSIBILITIES_V850.map(([code,title])=>({id:`SETRESP:${a[1]}:${code}`,title})),'Responsibility');return true;}
  if((a=text.match(/^SR:(\d+):(.+)$/))){await setField(a[1],'role',a[2],admin);await showUser(from,await byEmp(a[1]));return true;}
  if((a=text.match(/^SA:(\d+):(ENTRY|VIEW_ONLY|ENTRY_VIEW|EDIT|FULL_ACCESS)$/))){await setAccessSyncedV858(a[1],a[2],admin);await sendText(from,`✅ Access + Authorities synchronized: ${a[2]}\nEmployee: ${a[1]}\nOnly Super Admin notified.`);await showUser(from,await byEmp(a[1]));return true;}
  if((a=text.match(/^SETRESP:(\d+):([A-Z_]+)$/))){const emp=a[1],role=a[2],u=await byEmp(emp);if(!u){await sendText(from,'Employee not found.');return true;}const base=role==='NORMAL_EMPLOYEE'?workResponsibilityV83(u):`${role.replaceAll('_',' ')} • ${canonicalArea(u.area_of_working)} • ${canonicalSection(u.section_department)}`,o=await saveAdminOverrideV850(emp,{operational_role:role,responsibility:base},normWA(from));await applyAdminOverrideV850(u,o,normWA(from));await sendText(from,`✅ Responsibility changed: ${role.replaceAll('_',' ')}\nEmployee: ${emp}\nOnly Super Admin notified.`);return true;}
  if((a=text.match(/^SP:(\d+):(.+)$/))){await setField(a[1],'resp',a[2],admin);await showUser(from,await byEmp(a[1]));return true;}
  if((a=text.match(/^ADM_TEST:(\d+)$/))){const u=await byEmp(a[1]);if(!u){await sendText(from,'Employee not found.');return true;}await sendGovernanceTestV841(from,u);return true;}
  if((a=text.match(/^ADM_AUTH:(\d+)$/))){await sendList(from,'Authorities','Toggle',[
{id:`AU:${a[1]}:ENTRY`,title:'Entry'},{id:`AU:${a[1]}:VIEW`,title:'View'},{id:`AU:${a[1]}:EDIT`,title:'Edit / Correct'},
{id:`AU:${a[1]}:DELETE_UNDO`,title:'Delete / Undo'},{id:`AU:${a[1]}:APPROVAL`,title:'Approval'},
{id:`AU:${a[1]}:PDF`,title:'PDF'},{id:`AU:${a[1]}:PRINT_EXPORT`,title:'Print / Export'},{id:`AU:${a[1]}:EXCEL`,title:'Excel'},
{id:`AU:${a[1]}:ANALYSIS`,title:'Analysis'},{id:`AU:${a[1]}:REPORTS`,title:'Reports'},
{id:`AU:${a[1]}:ADVANCED_REPORTS`,title:'Advanced Reports'},{id:`AU:${a[1]}:RCM`,title:'RCM Analysis'}],'Authority Control');return true;}
  if((a=text.match(/^AU:(\d+):(ENTRY|VIEW|EDIT|DELETE_UNDO|APPROVAL|PDF|PRINT_EXPORT|EXCEL|ANALYSIS|REPORTS|ADVANCED_REPORTS|RCM)$/))){const ac=await toggleAuthoritySyncedV858(a[1],a[2],admin);await sendText(from,`✅ Authority toggled: ${a[2]}\nAccess recalculated: ${ac}\nOnly Super Admin notified.`);await showUser(from,await byEmp(a[1]));return true;}
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
  if(/^version$/i.test(text)){await sendText(from,'LMMM AI Maintenance V8.5.8 AUTO ASSIGN');return true;}
  return false;
}
async function processMessage(from,text,payload=''){
  const cmd=String(payload||text||'').trim();
  try{await pool.query(`CREATE TABLE IF NOT EXISTS ui_sessions(whatsapp_number TEXT NOT NULL,session_key TEXT NOT NULL,session_value JSONB,updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(whatsapp_number,session_key))`);}catch(e){console.error('[SESSION_SCHEMA]',e.message);}
  if(isOwner(from) && /^PURGE_TESTERS$/i.test(cmd)){await sendButtons(from,'Delete all TESTER registrations/profile/contact/roster data? MAIN users and Super Admin are preserved.',[{id:'PURGE_TESTERS_CONFIRM',title:'Confirm Delete'},{id:'BACK',title:'Cancel'}]);return;}
  if(isOwner(from) && cmd==='PURGE_TESTERS_CONFIRM'){const n=await purgeTesterUsersV854(normWA(from));await sendText(from,`✅ Tester cleanup completed.\nTester users removed: ${n}\nMAIN users preserved.`);return;}
  // V8.5.8 Super Admin contact-directory free-text edit continuation.

  // V8.5.8 user contact self-service and natural contact-detail capture.
  // V8.5.8 resilient Super Admin employee lookup.
  if(isOwner(from)){
    const q855=String(text||'').trim(), emp855=/^\d{3,}$/.test(q855);
    const name855=/^[A-Za-z][A-Za-z .'-]{2,50}$/.test(q855)&&!['hi','hello','hey','start','back','search','version'].includes(q855.toLowerCase());
    if(!payload && (emp855||name855)){
      const rr=emp855?(await pool.query('SELECT * FROM users WHERE employee_number=$1 LIMIT 1',[q855])).rows:(await pool.query('SELECT * FROM users WHERE lower(name)=lower($1) ORDER BY employee_number LIMIT 10',[q855])).rows;
      if(rr.length===1){
        const u=rr[0];await ensureProfile(u,normWA(from));const pr=(await pool.query('SELECT * FROM user_access_profile WHERE employee_number=$1',[u.employee_number])).rows[0];
        await sendText(from,`Employee Details\n\nName: ${u.name}\nEmployee No: ${u.employee_number}\nDesignation: ${u.designation||'-'}\nArea: ${u.area_of_working||'-'}\nSection: ${u.section_department||'-'}\nShift: ${u.shift||'-'}\nCategory/Role: ${pr?.assigned_role||'-'}\nAccess: ${pr?.access_level||'-'}\nResponsibility: ${pr?.responsibility||'-'}\nAuthorities: ${(pr?.authorities||[]).join(', ')||'-'}\nSource: ${pr?.assignment_source||'AUTO'}\nData Class: ${u.data_class||'MAIN'}`);
        await sendButtons(from,'Employee Actions',[{id:`ADM_ASSIGN:${u.employee_number}`,title:'Assign / Change'},{id:`ADM_CONTACT:${u.employee_number}`,title:'Contact Details'},{id:`ADM_MORE:${u.employee_number}`,title:'More Options'}]);return;
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
  // V8.5.8 approved-user employee directory: basic public internal fields only.
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
  if(await adminCommand(from,clean)) return;

  const greeting=/^(hi+|hello+|hey+|start)[.! ]*$/i.test(clean);
  const selfRemove=/^(remove|remov|delete)\s+me[.! ]*$/i.test(clean) || /^(exit|quit|deactivate)[.! ]*$/i.test(clean);
  let u=await byWA(from);

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
  try{await pool.query('SELECT 1');res.json({ok:true,version:'8.4.1',phase:'registration',db:true});}
  catch(e){res.status(500).json({ok:false,version:'8.4.1',error:e.message});}
});
app.get('/webhook',(req,res)=>{
  const mode=req.query['hub.mode'], token=req.query['hub.verify_token'], challenge=req.query['hub.challenge'];
  if(mode==='subscribe' && token===VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});
app.post('/webhook',(req,res)=>{
  res.sendStatus(200);
  const entries=req.body?.entry||[];
  for(const e of entries) for(const c of e.changes||[]) for(const m of c.value?.messages||[]){
    let text='', payload='';
    if(m.type==='text') text=m.text?.body||'';
    else if(m.type==='interactive' && m.interactive?.type==='button_reply'){
      text=m.interactive.button_reply?.title||''; payload=m.interactive.button_reply?.id||'';
    } else if(m.type==='interactive' && m.interactive?.type==='list_reply'){
      text=m.interactive.list_reply?.title||''; payload=m.interactive.list_reply?.id||'';
    } else continue;
    processMessage(normWA(m.from),text,payload).catch(err=>console.error('[MESSAGE]',err));
  }
});

await initDB();
app.listen(PORT,'0.0.0.0',()=>console.log(`[LMMM] V8.5.8 registration foundation listening on ${PORT}`));
