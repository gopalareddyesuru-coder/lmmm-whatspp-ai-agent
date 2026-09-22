// LMMM AI Maintenance V8.2.0
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

function canonicalArea(v=''){
  const raw=String(v||'').trim(); if(!raw) return null;
  const k=raw.toLowerCase().replace(/[._-]+/g,' ').replace(/\s+/g,' ').trim();
  const aliases = {
    'bdm':'BDM','breakdown mill':'BDM','break down mill':'BDM','billet mill':'BDM','billetmill':'BDM',
    'bar mill':'BAR MILL','barmill':'BAR MILL','finishing':'FINISHING','finishing mill':'FINISHING',
    'wbf':'WBF','walking beam furnace':'WBF','furnace':'WBF'
  };
  return aliases[k] || raw.toUpperCase();
}
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
function canonicalSection(v=''){
  const raw=String(v||'').trim(); if(!raw) return null;
  const k=raw.toLowerCase().replace(/[._-]+/g,' ').replace(/\s+/g,' ').trim();
  const aliases={'mech':'Mechanical','mechanical':'Mechanical','mm':'Mechanical','ops':'Operations','operation':'Operations','operations':'Operations','production':'Operations','elec':'Electrical','electrical':'Electrical','inst':'Instrumentation','instrumentation':'Instrumentation','etl':'ETL','telecom':'Telecommunications','water':'Water Management','dnw':'DNW','enmd':'EnMD','red':'RED'};
  return aliases[k] || raw.replace(/\b\w/g,c=>c.toUpperCase());
}
function canonicalShift(v=''){
  const raw=String(v||'').trim(); if(!raw) return null;
  const k=raw.toLowerCase().replace(/[\s._-]+/g,'');
  if(['a','ashift','1','first'].includes(k)) return 'A';
  if(['b','bshift','2','second'].includes(k)) return 'B';
  if(['c','cshift','3','third','night','nightshift'].includes(k)) return 'C';
  if(['g','gs','gshift','gen','genrl','generl','general','generalshift','generalshft'].includes(k)) return 'General';
  return raw;
}
const SHIFT_TIMINGS={
  A:{start:'06:00',end:'14:30'},
  B:{start:'14:00',end:'22:30'},
  C:{start:'22:00',end:'06:30'},
  General:{start:'09:00',end:'17:30'}
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
    designation:canonicalDesignation(d.designation),
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

async function ensureProfile(u,by='SYSTEM'){
  const d=String(u.designation||'').toLowerCase();
  let role='NORMAL_USER',access='RELEVANT_MODULE_ENTRY';
  if(/deputy general manager|general manager|chief general manager|executive director|\bcmd\b/.test(d)){role='FULL_ACCESS';access='FULL_ACCESS';}
  else if(/assistant general manager|senior manager|manager|deputy manager|assistant manager|junior manager|management trainee/.test(d)){role='EXECUTIVE';access='ENTRY_VIEW';}
  const area=String(u.area_of_working||'').toUpperCase(), section=String(u.section_department||'').toLowerCase();
  let resp=[u.area_of_working,u.section_department].filter(Boolean).join(' ')||'General';
  if(area==='BDM' && section==='mechanical') resp='BDM Equipment Maintenance & Availability; Support uninterrupted production';
  if(u.shift==='General') resp += '; General Shift coordination';
  else if(['A','B','C'].includes(u.shift)) resp += `; ${u.shift} Shift maintenance coverage`;
  await pool.query(`INSERT INTO user_access_profile(employee_number,assigned_role,access_level,responsibility,assigned_by)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(employee_number) DO NOTHING`,[u.employee_number,role,access,resp,by]);
}
async function showUser(to,u){
  await ensureProfile(u,normWA(to));
  const r=await pool.query('SELECT * FROM user_access_profile WHERE employee_number=$1',[u.employee_number]),p=r.rows[0];
  await sendButtons(to,`Employee Details
Name: ${u.name}
Employee No: ${u.employee_number}
Designation: ${u.designation||'-'}
Area: ${u.area_of_working||'-'}
Section: ${u.section_department||'-'}
Shift: ${u.shift||'-'}${SHIFT_TIMINGS[u.shift]?` (${SHIFT_TIMINGS[u.shift].start}-${SHIFT_TIMINGS[u.shift].end})`:''}
Status: ${u.approval_status}${u.is_active?' / Active':''}

Role: ${p?.assigned_role||'-'}
Access: ${p?.access_level||'-'}
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
  if((a=text.match(/^ADM_ASSIGN:(\d+)$/))){await sendButtons(from,'Assign / Change',[{id:`ADM_ROLE:${a[1]}`,title:'Role'},{id:`ADM_ACCESS:${a[1]}`,title:'Access'},{id:`ADM_RESP:${a[1]}`,title:'Responsibility'}]);return true;}
  if((a=text.match(/^ADM_MORE:(\d+)$/))){await sendButtons(from,'More user controls',[{id:`ADM_AUTH:${a[1]}`,title:'Authorities'},{id:`ADM_REMOVE:${a[1]}`,title:'Remove User'},{id:`ADM_VIEW:${a[1]}`,title:'Back'}]);return true;}
  if((a=text.match(/^ADM_ROLE:(\d+)$/))){await sendButtons(from,'Select Role',[{id:`SR:${a[1]}:NORMAL_USER`,title:'Normal User'},{id:`SR:${a[1]}:EXECUTIVE`,title:'Executive'},{id:`SR:${a[1]}:SHIFT_INCHARGE`,title:'Shift In-charge'}]);return true;}
  if((a=text.match(/^ADM_ACCESS:(\d+)$/))){await sendButtons(from,'Select Access',[{id:`SA:${a[1]}:ENTRY`,title:'Entry'},{id:`SA:${a[1]}:ENTRY_VIEW`,title:'Entry + View'},{id:`SA:${a[1]}:FULL_ACCESS`,title:'Full Access'}]);return true;}
  if((a=text.match(/^ADM_RESP:(\d+)$/))){await sendButtons(from,'Select Responsibility',[{id:`SP:${a[1]}:AREA_INCHARGE`,title:'Area In-charge'},{id:`SP:${a[1]}:SHIFT_INCHARGE`,title:'Shift In-charge'},{id:`SP:${a[1]}:GENERAL_SHIFT`,title:'General Shift'}]);return true;}
  if((a=text.match(/^SR:(\d+):(.+)$/))){await setField(a[1],'role',a[2],admin);await showUser(from,await byEmp(a[1]));return true;}
  if((a=text.match(/^SA:(\d+):(.+)$/))){await setField(a[1],'access',a[2],admin);await showUser(from,await byEmp(a[1]));return true;}
  if((a=text.match(/^SP:(\d+):(.+)$/))){await setField(a[1],'resp',a[2],admin);await showUser(from,await byEmp(a[1]));return true;}
  if((a=text.match(/^ADM_AUTH:(\d+)$/))){await sendButtons(from,'Toggle Authority',[{id:`AU:${a[1]}:PDF`,title:'PDF'},{id:`AU:${a[1]}:ANALYSIS`,title:'Analysis'},{id:`AU:${a[1]}:RCM`,title:'RCM'}]);return true;}
  if((a=text.match(/^AU:(\d+):(PDF|ANALYSIS|RCM)$/))){await toggleAuth(a[1],a[2],admin);await showUser(from,await byEmp(a[1]));return true;}
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
    await ensureProfile(u,normWA(from));
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
  if(/^version$/i.test(text)){await sendText(from,'LMMM AI Maintenance V8.2.0 REGISTRATION ACCEPTANCE');return true;}
  return false;
}
async function processMessage(from,text,payload=''){
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
  try{await pool.query('SELECT 1');res.json({ok:true,version:'8.0.3',phase:'registration',db:true});}
  catch(e){res.status(500).json({ok:false,version:'8.0.3',error:e.message});}
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
    } else continue;
    processMessage(normWA(m.from),text,payload).catch(err=>console.error('[MESSAGE]',err));
  }
});

await initDB();
app.listen(PORT,'0.0.0.0',()=>console.log(`[LMMM] V8.2.0 registration foundation listening on ${PORT}`));
