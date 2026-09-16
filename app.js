import express from 'express';
import 'dotenv/config';

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
    verify_token_configured: Boolean(VERIFY_TOKEN)
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

// Send WhatsApp text message
async function sendWhatsAppText(to, text) {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    console.error('[WHATSAPP SEND] Missing META_PHONE_NUMBER_ID or META_ACCESS_TOKEN');
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

// Incoming WhatsApp messages
app.post('/webhook', (req, res) => {
  // Respond to Meta immediately
  res.sendStatus(200);

  try {
    console.log('WHATSAPP WEBHOOK:', JSON.stringify(req.body));

    const change = req.body?.entry?.[0]?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      console.log('[WEBHOOK] No message object in payload.');
      return;
    }

    const from = message.from;
    const type = message.type;
    const text = message.text?.body || '';

    console.log('[MESSAGE]', {
      from,
      type,
      text
    });

    // First test reply only
    if (type === 'text') {
      sendWhatsAppText(
        from,
        'LMMM Maintenance AI Agent active. Mee maintenance query pampandi.'
      ).catch(err => {
        console.error('[SEND ERROR]', err);
      });
    }

  } catch (err) {
    console.error('[WEBHOOK ERROR]', err);
  }
});

app.get('/api/status', (_req, res) => {
  res.status(200).json({
    status: 'ready',
    webhook: '/webhook',
    whatsapp_reply: 'enabled'
  });
});

app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.originalUrl}`);
  res.status(404).send('Not found');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LMMM AI Maintenance Agent listening on ${PORT}`);
});
