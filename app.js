import express from 'express';
import 'dotenv/config';

const app = express();
app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || '';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';

app.get('/health', (_req, res) => {
  res.json({
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
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN && challenge) {
    console.log('WEBHOOK VERIFIED');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Receive WhatsApp events. Always acknowledge quickly.
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  try {
    console.log('WHATSAPP WEBHOOK:', JSON.stringify(req.body));
    const change = req.body?.entry?.[0]?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const type = message.type;
    const text = message.text?.body || '';
    const name = value?.contacts?.[0]?.profile?.name || from;

    console.log('INCOMING MESSAGE', { from, name, type, text });

    // AI/data-processing layer will be connected here next.
    // Current stage intentionally only receives and logs events.
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
});

// Safe test endpoint for the backend itself.
app.get('/api/status', (_req, res) => {
  res.json({
    status: 'ready',
    next: 'Connect Meta webhook, then enable message subscription.'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LMMM AI Maintenance Agent listening on ${PORT}`);
});
