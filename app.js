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

app.post('/webhook', (req, res) => {
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

    console.log('[MESSAGE]', {
      from: message.from,
      type: message.type,
      text: message.text?.body || ''
    });

    // AI/data-processing layer will be connected after webhook verification.
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err);
  }
});

app.get('/api/status', (_req, res) => {
  res.status(200).json({
    status: 'ready',
    webhook: '/webhook',
    next: 'Verify Meta webhook and subscribe to messages.'
  });
});

app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.originalUrl}`);
  res.status(404).send('Not found');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LMMM AI Maintenance Agent listening on ${PORT}`);
});
