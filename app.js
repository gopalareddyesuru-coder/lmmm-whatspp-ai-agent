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

  console.log('[DATABASE] V4.2 registration/removal ready');
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

  let sent = 0;
  for (const admin of SUPER_ADMIN_NUMBERS) {
    try {
      await sendText(
        admin,
        `Registration approval:\n${d.name} / ${d.employee_number} / ${d.designation} / ${d.section} / ${d.area}\n\nAPPROVE ${d.employee_number}\nREJECT ${d.employee_number}`
      );
      sent++;
      console.log('[APPROVAL] Sent to', admin);
    } catch (e) {
      console.error('[APPROVAL SEND ERROR]', admin, e);
    }
  }
  return sent > 0;
}

async function ownerCommand(from, text) {
  const admin = from.replace(/\D/g, '');
  if (!SUPER_ADMIN_NUMBERS.has(admin)) return false;

  let m = text.match(/^approve\s+(\d+)$/i);
  if (m) {
    const u = await byEmp(m[1]);
    if (!u) {
      await sendText(from, 'Not found.');
      return true;
    }

    await pool.query(
      `UPDATE users
       SET approval_status='approved', is_active=true, updated_at=now()
       WHERE employee_number=$1`,
      [m[1]]
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
    await sendText(from, `Approved ${m[1]}.`);
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

    await sendText(wa, 'Registration rejected.');
    await sendText(from, `Rejected and removed ${m[1]}.`);
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
    await sendText(from, `Confirm removal: CONFIRM REMOVE ${m[1]}`);
    return true;
  }

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
    await sendText(from, 'Confirm reset: CONFIRM RESET REGISTRATIONS');
    return true;
  }

  if (/^confirm reset registrations$/i.test(text.trim())) {
    await pool.query('BEGIN');
    try {
      await pool.query('DELETE FROM user_special_permissions');
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

async function processMessage(from, text) {
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
    if (/^(hi|hello|hey|start)$/i.test(clean)) {
      await sendText(from, T('welcome', te));
      return;
    }

    await sendText(from, T('notfound', te));
    return;
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

      const text = m.text?.body || '';
      console.log('[MESSAGE]', { from: m.from, type: m.type, text });

      if (m.type !== 'text') {
        await sendText(m.from, 'Not found.');
        return;
      }

      await processMessage(m.from, text);
    } catch (e) {
      console.error('[WEBHOOK ERROR]', e);
    }
  })();
});

app.get('/api/status', (_q, r) =>
  r.status(200).json({
    status: 'ready',
    registration: 'V4.2',
    webhook: '/webhook',
    super_admins_configured: SUPER_ADMIN_NUMBERS.size
  })
);

app.use((_q, r) => r.status(404).send('Not found'));

initDB().catch(e => console.error('[DATABASE INIT ERROR]', e));

app.listen(PORT, '0.0.0.0', () =>
  console.log(`LMMM AI Maintenance Agent listening on ${PORT}`)
);
