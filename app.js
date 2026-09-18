import express from 'express';
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const app = express();
app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = (process.env.META_VERIFY_TOKEN || '').trim();
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || '';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

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
  await pool.query(`ALTER TABLE section_event_log ADD COLUMN IF NOT EXISTS equipment TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_section_event_equipment ON section_event_log(equipment)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_section_event_date ON section_event_log(event_date,section,area,event_type)`);

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
 const x=String(v).trim();
 if(/^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
 const m=x.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
 return m?`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`:null;
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
   (await pool.query(`SELECT * FROM production_shift_logs WHERE production_date=$1 AND LOWER(area)=LOWER($2) ORDER BY shift,id`,[date,area])).rows:
   (await pool.query(`SELECT * FROM production_shift_logs WHERE production_date=$1 ORDER BY area,shift,id`,[date])).rows;
 if(!p.length)return 'Not found.';
 let out=[];
 for(const x of p){
   const ds=(await pool.query(`SELECT * FROM production_delays WHERE production_log_id=$1 ORDER BY id`,[x.id])).rows;
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
async function saveSectionEvent(u,from,type,text,eventDate=null,eventShift=null,timingSource='entry_context',equipment=null){
  const n=plantNow(),ctx=await currentShiftContext(u),resp=await responsibilityName(u.employee_number);
  const d=eventDate||n.date,sh=eventShift||ctx.shift;
  const r=await pool.query(`INSERT INTO section_event_log(
    event_type,event_text,equipment,employee_number,employee_name,section,area,responsibility,event_date,event_shift,event_time,entered_by,timing_source)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [type,text,equipment,u.employee_number,u.name,u.section_department,u.area_of_working,resp,d,sh,eventDate?null:n.time,from,timingSource]);
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


function languageOf(t=''){
 if(/[\u0C00-\u0C7F]/.test(t))return 'te';
 if(/[\u0900-\u097F]/.test(t))return 'hi';
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
 return `You extract LMMM steel-plant maintenance/shift data.
Return valid JSON only with this exact structure:
{"language":"en|te|hi","uncertain":boolean,"needs_event_time":boolean,"summary":string,"entries":[{"type":"production|delay|inspection|defect|job_action|logbook_note","equipment":string|null,"text":string,"confidence":number,"blooms_rolled":number|null,"delay_minutes":number|null,"delay_section":string|null,"reason":string|null,"event_date":string|null,"event_shift":"A|B|C|GENERAL|null"}]}.
For clear Telugu/Hindi/English voice or text, write each entry.text as concise STANDARD TECHNICAL ENGLISH suitable for the maintenance database. Example: "Charging Grid 2 chain loose observe chesam" -> equipment="Charging Grid 2", text="Chain found loose".
Do not translate or alter exact equipment/SAP/CAT/drawing/part identifiers.
Never invent unreadable data. Preserve equipment/SAP/CAT/drawing/part identifiers exactly as supplied/visible.
Primary production is blooms rolled. Do not invent tonnes.
Section=${u.section_department}; Area=${u.area_of_working}; Current shift=${ctx.shift||'unknown'}.
If event date/shift is unclear for an apparently old/late entry, set needs_event_time=true.`;
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
 return JSON.parse(txt.replace(/^```json\s*/i,'').replace(/```$/,'').trim());
}
async function classifyExtracted(text,u,ctx){
 return geminiGenerate([{text:`Classify and extract every relevant LMMM entry from this message:\n${text}`}],u,ctx);
}
async function extractPhoto(buf,mime,u,ctx){
 return geminiGenerate([
   {text:'Read this shift log-book/photo carefully and extract every relevant readable entry. Mark uncertain=true for doubtful handwriting or values.'},
   {inline_data:{mime_type:mime||'image/jpeg',data:buf.toString('base64')}}
 ],u,ctx);
}
async function extractAudio(buf,mime,u,ctx){
 return geminiGenerate([
   {text:'Transcribe/understand this voice or audio message and extract every relevant LMMM entry. Detect Telugu, English or Hindi and preserve technical identifiers exactly.'},
   {inline_data:{mime_type:mime||'audio/ogg',data:buf.toString('base64')}}
 ],u,ctx);
}
async function extractDocument(buf,mime,u,ctx){
 return geminiGenerate([
   {text:'Read this document and extract relevant LMMM maintenance/production/log-book entries. Do not guess unreadable identifiers.'},
   {inline_data:{mime_type:mime,data:buf.toString('base64')}}
 ],u,ctx);
}
async function stageMedia(u,from,msg){
 const n=msg.image||msg.audio||msg.voice||msg.document;
 const type=msg.image?'image':(msg.audio||msg.voice)?'audio':'document';
 const meta=await mediaMeta(n.id), mime=meta.mime_type||n.mime_type||'', name=n.filename||`${type}-${n.id}`;
 const buf=await mediaBytes(meta.url),ctx=await currentShiftContext(u);
 let raw='',obj;
 if(type==='audio'){obj=await extractAudio(buf,mime,u,ctx);raw=obj.summary||'';}
 else if(type==='image'){obj=await extractPhoto(buf,mime,u,ctx);raw=obj.summary||'';}
 else if(/text|csv|json|xml/i.test(mime)){raw=buf.toString('utf8').slice(0,150000);obj=await classifyExtracted(raw,u,ctx);}
 else if(/pdf/i.test(mime)){obj=await extractDocument(buf,mime,u,ctx);raw=obj.summary||'';}
 else {obj={language:'en',uncertain:true,needs_event_time:false,summary:'File received. This file type is not parsed automatically yet.',entries:[]};}
 const lang=obj.language||languageOf(raw);
 const entries=obj.entries||[];
 const clear = entries.length>0 && !obj.uncertain && !obj.needs_event_time &&
   entries.every(e => Number(e.confidence ?? 1) >= 0.85 && String(e.text||'').trim());
 const q=await pool.query(`INSERT INTO media_ingestion(employee_number,media_id,media_type,mime_type,filename,detected_language,extracted_text,extraction_json,status,entered_by)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
 [u.employee_number,n.id,type,mime,name,lang,raw,obj,clear?'auto_processing':'pending_confirmation',from]);

 if(clear){
   const p={media_ingestion_id:q.rows[0].id,proposed_json:obj};
   await commitMedia(u,from,p,true);
   const saved=entries.slice(0,15).map(e=>{
     const eq=e.equipment?`${e.equipment} – `:'';
     return `${eq}${e.text||''}`;
   }).join('\n');
   await sendText(from,ml(lang,`Saved.\n${saved}`,`సేవ్ అయింది.\n${saved}`,`सेव हो गया।\n${saved}`));
   return;
 }

 await pool.query(`INSERT INTO pending_media_confirmations(employee_number,media_ingestion_id,proposed_json) VALUES($1,$2,$3)
 ON CONFLICT(employee_number) DO UPDATE SET media_ingestion_id=EXCLUDED.media_ingestion_id,proposed_json=EXCLUDED.proposed_json,created_at=now()`,
 [u.employee_number,q.rows[0].id,obj]);
 const lines=entries.slice(0,15).map((e,i)=>`${i+1}. ${e.type}: ${e.equipment?e.equipment+' – ':''}${e.text||''}`).join('\n');
 const ask=obj.needs_event_time?ml(lang,'When did it happen?','ఇది ఎప్పుడు జరిగింది?','यह कब हुआ था?'):
   ml(lang,'Please verify: CONFIRM / CORRECT','దయచేసి చెక్ చేయండి: CONFIRM / CORRECT','कृपया जाँचें: CONFIRM / CORRECT');
 await sendText(from,`${lines||obj.summary}\n\n${ask}`);
}
async function commitMedia(u,from,p,auto=false){
 const o=p.proposed_json,ctx=await currentShiftContext(u),n=plantNow();
 for(const e of (o.entries||[])){
  const d=e.event_date||n.date,sh=e.event_shift||ctx.shift;
  if(e.type==='production' && Number.isInteger(e.blooms_rolled)){
   await pool.query(`INSERT INTO production_shift_logs(production_date,shift,area,blooms_rolled,operations_shift_incharge,remarks,entered_by)
   VALUES($1,$2,$3,$4,$5,$6,$7)`,[d,sh||'Not found',u.area_of_working,e.blooms_rolled,u.name,`Media: ${e.text||''}`,from]);
  }else if(['inspection','defect','job_action','logbook_note'].includes(e.type)){
   await saveSectionEvent(u,from,e.type,e.text||'',d,sh,auto?'media_auto':'media_confirmed',e.equipment||null);
  }
 }
 await pool.query(`UPDATE media_ingestion SET status=$2 WHERE id=$1`,[p.media_ingestion_id,auto?'auto_saved':'confirmed']);
 await pool.query(`DELETE FROM pending_media_confirmations WHERE employee_number=$1`,[u.employee_number]);
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
  const clean = String(text || '').trim();
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

    if(rawMessage && (rawMessage.image||rawMessage.audio||rawMessage.voice||rawMessage.document)){
      try{await stageMedia(u,from,rawMessage);}catch(e){console.error('[MEDIA]',e);await sendText(from,'Could not process this file.');}
      return;
    }
    if(/^CONFIRM$/i.test(clean)){
      const p=(await pool.query(`SELECT * FROM pending_media_confirmations WHERE employee_number=$1`,[u.employee_number])).rows[0];
      if(!p){await sendText(from,'Not found.');return;}
      await commitMedia(u,from,p);
      const l=p.proposed_json?.language||'en';
      await sendText(from,ml(l,'Saved.','సేవ్ అయింది.','सेव हो गया।'));return;
    }
    if(/^CORRECT$/i.test(clean)){
      await sendText(from,ml(languageOf(clean),'Send the correction in text.','సరిచేయాల్సిన వివరాన్ని టెక్స్ట్‌లో పంపండి.','सही जानकारी टेक्स्ट में भेजें।'));return;
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

    // Natural inspection / defect / job-action entry for every section.
    const et=classifySectionEvent(clean);
    if(et && !/^PROD|^DELAY/i.test(clean)){
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
    await sendText(from,T('notfound',te));return;
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

app.get('/health', (_q, r) =>
  r.status(200).json({
    ok: true,
    database_configured: Boolean(DATABASE_URL),
    phone_number_id_configured: Boolean(PHONE_NUMBER_ID),
    access_token_configured: Boolean(ACCESS_TOKEN),
    super_admins_configured: SUPER_ADMIN_NUMBERS.size
  })
);

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
    registration: 'V5.2-auto-english-equipment-routing',
    webhook: '/webhook',
    super_admins_configured: SUPER_ADMIN_NUMBERS.size
  })
);

app.use((_q, r) => r.status(404).send('Not found'));

initDB().catch(e => console.error('[DATABASE INIT ERROR]', e));

app.listen(PORT, '0.0.0.0', () =>
  console.log(`LMMM AI Maintenance Agent listening on ${PORT}`)
);
