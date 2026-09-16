import express from 'express';
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      whatsapp_number VARCHAR(20) UNIQUE NOT NULL,
      name TEXT,
      employee_number VARCHAR(50) UNIQUE,
      designation TEXT,
      area_of_working TEXT,
      section_department TEXT,
      system_role TEXT DEFAULT 'pending',
      approval_status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log('[DATABASE] Users table ready');
}

const app = express();

app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = (process.env.META_VERIFY_TOKEN || '').trim();
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || '';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';

app.use((req, _res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.originalUrl}`);
  next();
});

app.get('/', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'LMMM WhatsApp AI Maintenance Agent',
    status: 'live',
    webhook: '/webhook'
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'LMMM WhatsApp AI Maintenance Agent',
    webhook: '/webhook',
    graph_version: GRAPH_VERSION,
    phone_number_id_configured: Boolean(PHONE_NUMBER_ID),
    access_token_configured: Boolean(ACCESS_TOKEN),
    verify_token_configured: Boolean(VERIFY_TOKEN),
    database_configured: Boolean(process.env.DATABASE_URL)
  });
});

// Meta webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = String(req.query['hub.verify_token'] ?? '').trim();
  const challenge = req.query['hub.challenge'];

  console.log('[WEBHOOK VERIFY]', {
    mode,
    token_received: Boolean(token),
    token_length: token.length,
    token_matches: token === VERIFY_TOKEN,
    challenge_received: Boolean(challenge)
  });

  if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
    console.log('WEBHOOK VERIFIED');
    return res.status(200).send(String(challenge));
  }

  return res.status(403).send('Forbidden');
});

// Send WhatsApp text
async function sendWhatsAppText(to, text) {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    console.error(
      '[WHATSAPP SEND] Missing META_PHONE_NUMBER_ID or META_ACCESS_TOKEN'
    );
    return;
  }

  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: {
        body: text
      }
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[WHATSAPP SEND ERROR]', data);
    return;
  }

  console.log('[WHATSAPP SENT]', JSON.stringify(data));
}

// Registration welcome
const REGISTRATION_MESSAGE = `
Welcome to LMMM Maintenance AI Agent 👋

Welcome to the LMMM Mechanical Maintenance digital assistant.

To get started, please enter your details:

1. Name
2. Employee Number
3. Designation
4. Area of Working
5. Section / Department

Your WhatsApp number will be captured automatically.

Please enter your Name to continue.
`.trim();

// Main menu - authority based menu will be added later
function getMainMenu(user) {
  return `
Welcome back, ${user.name || 'User'} 👋

LMMM Maintenance AI Agent

Please select an option:

1️⃣ Log Book
2️⃣ Defects
3️⃣ Jobs
4️⃣ Breakdown / Delay
5️⃣ Inspection
6️⃣ CBM / Vibration
7️⃣ Equipment
8️⃣ History
9️⃣ Spares
🔟 SMP / SOP

Reply with the option number.
`.trim();
}

// Process registration
async function processRegistration(from, text) {
  const result = await pool.query(
    `SELECT * FROM users WHERE whatsapp_number = $1`,
    [from]
  );

  let user = result.rows[0];

  // First-time WhatsApp number
  if (!user) {
    await pool.query(
      `INSERT INTO users (whatsapp_number)
       VALUES ($1)
       ON CONFLICT (whatsapp_number) DO NOTHING`,
      [from]
    );

    console.log('[REGISTRATION] New user created:', from);

    await sendWhatsAppText(from, REGISTRATION_MESSAGE);
    return;
  }

  // Registration field 1 - Name
  if (!user.name) {
    await pool.query(
      `UPDATE users
       SET name = $1, updated_at = NOW()
       WHERE whatsapp_number = $2`,
      [text, from]
    );

    await sendWhatsAppText(
      from,
      'Thank you. Now please enter your Employee Number.'
    );
    return;
  }

  // Registration field 2 - Employee Number
  if (!user.employee_number) {
    try {
      await pool.query(
        `UPDATE users
         SET employee_number = $1, updated_at = NOW()
         WHERE whatsapp_number = $2`,
        [text, from]
      );

      await sendWhatsAppText(
        from,
        'Employee Number saved.\n\nNow please enter your Designation.'
      );
    } catch (err) {
      if (err.code === '23505') {
        await sendWhatsAppText(
          from,
          'This Employee Number is already registered with another WhatsApp number. Please contact LMMM Admin for verification.'
        );
      } else {
        throw err;
      }
    }

    return;
  }

  // Registration field 3 - Designation
  if (!user.designation) {
    await pool.query(
      `UPDATE users
       SET designation = $1, updated_at = NOW()
       WHERE whatsapp_number = $2`,
      [text, from]
    );

    await sendWhatsAppText(
      from,
      'Designation saved.\n\nNow please enter your Area of Working.'
    );
    return;
  }

  // Registration field 4 - Area of Working
  if (!user.area_of_working) {
    await pool.query(
      `UPDATE users
       SET area_of_working = $1, updated_at = NOW()
       WHERE whatsapp_number = $2`,
      [text, from]
    );

    await sendWhatsAppText(
      from,
      'Area of Working saved.\n\nNow please enter your Section / Department.'
    );
    return;
  }

  // Registration field 5 - Section / Department
  if (!user.section_department) {
    await pool.query(
      `UPDATE users
       SET section_department = $1,
           approval_status = 'pending',
           system_role = 'pending',
           updated_at = NOW()
       WHERE whatsapp_number = $2`,
      [text, from]
    );

    await sendWhatsAppText(
      from,
      `Registration completed successfully ✅

Your details have been submitted to LMMM Maintenance AI Agent.

Your access is currently pending approval.

Once your authority is assigned, you can access the permitted maintenance modules.

Thank you.`
    );

    console.log('[REGISTRATION] Completed:', from);
    return;
  }

  // Registration already completed
  if (user.approval_status === 'pending') {
    await sendWhatsAppText(
      from,
      `Welcome back, ${user.name || 'User'} 👋

Your registration is already completed.

Your LMMM Maintenance AI Agent access is currently pending approval.

Please contact the authorised LMMM Admin if approval is required.`
    );
    return;
  }

  // Approved user
  if (user.approval_status === 'approved') {
    await sendWhatsAppText(from, getMainMenu(user));
    return;
  }

  // Other status
  await sendWhatsAppText(
    from,
    `Welcome back, ${user.name || 'User'} 👋

Your registration is already available in the system.

Access status: ${user.approval_status || 'pending'}`
  );
}

// Incoming WhatsApp messages
app.post('/webhook', (req, res) => {
  // Respond to Meta immediately
  res.sendStatus(200);

  processIncomingMessage(req.body).catch(err => {
    console.error('[WEBHOOK ERROR]', err);
  });
});

async function processIncomingMessage(body) {
  console.log('WHATSAPP WEBHOOK:', JSON.stringify(body));

  const change = body?.entry?.[0]?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  if (!message) {
    console.log('[WEBHOOK] No message object in payload.');
    return;
  }

  const from = message.from;
  const type = message.type;
  const text = message.text?.body?.trim() || '';

  console.log('[MESSAGE]', {
    from,
    type,
    text
  });

  if (type !== 'text') {
    await sendWhatsAppText(
      from,
      'Please send your information as a text message for registration.'
    );
    return;
  }

  await processRegistration(from, text);
}

app.get('/api/status', (_req, res) => {
  res.status(200).json({
    status: 'ready',
    webhook: '/webhook',
    whatsapp_reply: 'enabled',
    database: 'enabled',
    registration: 'enabled'
  });
});

app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.originalUrl}`);
  res.status(404).send('Not found');
});

// Start application only after database initialization
initializeDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`LMMM AI Maintenance Agent listening on ${PORT}`);
    });
  })
  .catch(err => {
    console.error('[DATABASE STARTUP ERROR]', err);
    process.exit(1);
  });
