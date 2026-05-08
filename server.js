const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const express = require('express');
const cors = require('cors');
const P = require('pino');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let qrCodeData = null;
let isReady = false;
let lastError = null;
let startAttempt = 0;

const API_SECRET = process.env.API_SECRET || 'crewfund-secret-key';

function authenticate(req, res, next) {
  const secret = req.headers['x-api-secret'];
  if (secret !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

async function startClient() {
  startAttempt++;
  console.log(`[WA] Starting client (attempt ${startAttempt})...`);

  try {
    const { state, saveCreds } = await useMultiFileAuthState('./tokens');
    const { version } = await fetchLatestBaileysVersion();

    console.log(`[WA] Using Baileys version: ${version.join('.')}`);

    sock = makeWASocket({
      version,
      auth: state,
      logger: P({ level: 'silent' }),
      printQRInTerminal: true,
      browser: ['CrewFund', 'Chrome', '1.0.0'],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 2000,
    });

    // Save credentials whenever they update
    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCodeData = qr;
        isReady = false;
        console.log('[WA] QR Code ready — visit /qr to scan');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        isReady = false;
        qrCodeData = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[WA] Connection closed. Status: ${statusCode}. Reconnect: ${shouldReconnect}`);

        if (shouldReconnect) {
          console.log('[WA] Reconnecting in 3 seconds...');
          setTimeout(startClient, 3000);
        } else {
          console.log('[WA] Logged out — delete tokens folder and restart to reconnect');
          lastError = 'Logged out from WhatsApp';
        }
      }

      if (connection === 'open') {
        isReady = true;
        qrCodeData = null;
        lastError = null;
        console.log('[WA] ✅ WhatsApp connected and ready!');
      }

      if (connection === 'connecting') {
        console.log('[WA] Connecting to WhatsApp...');
      }
    });

  } catch (err) {
    lastError = err.message;
    console.error('[WA] Error starting client:', err.message);
    setTimeout(startClient, 5000);
  }
}

// Format phone number for Baileys
function formatPhone(phone) {
  let formatted = phone.replace(/[\s\-\(\)]/g, '');
  if (formatted.startsWith('+')) formatted = formatted.slice(1);
  if (formatted.startsWith('0')) formatted = '234' + formatted.slice(1);
  if (!formatted.startsWith('234') && !formatted.startsWith('44') && !formatted.startsWith('1')) {
    formatted = '234' + formatted;
  }
  return formatted + '@s.whatsapp.net';
}

// GET / — health check
app.get('/', (req, res) => {
  res.json({
    service: 'CrewFund WhatsApp Server',
    status: isReady ? 'connected' : 'disconnected',
    version: '2.0.0',
    library: 'Baileys',
  });
});

// GET /status
app.get('/status', (req, res) => {
  res.json({
    connected: isReady,
    hasQR: !!qrCodeData,
    startAttempt,
    lastError,
  });
});

// GET /qr — show QR code page
app.get('/qr', (req, res) => {
  if (isReady) {
    return res.send(`
      <html>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#FAF8F5;font-family:sans-serif;">
          <div style="font-size:64px;margin-bottom:16px;">✅</div>
          <h2 style="color:#309898;margin-bottom:8px;">WhatsApp Connected</h2>
          <p style="color:#888;">CrewFund is ready to send messages</p>
        </body>
      </html>
    `);
  }

  if (!qrCodeData) {
    return res.send(`
      <html>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#FAF8F5;font-family:sans-serif;">
          <div style="font-size:64px;margin-bottom:16px;">⏳</div>
          <h2 style="color:#309898;margin-bottom:8px;">Generating QR Code...</h2>
          <p style="color:#888;">Please wait a few seconds</p>
          <script>setTimeout(() => location.reload(), 3000)</script>
        </body>
      </html>
    `);
  }

  // Convert raw QR string to image using Google Charts API
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrCodeData)}`;

  res.send(`
    <html>
      <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#FAF8F5;font-family:sans-serif;">
        <h2 style="color:#309898;margin-bottom:8px;">Scan to connect WhatsApp</h2>
        <p style="color:#888;margin-bottom:24px;">Open WhatsApp → Settings → Linked Devices → Link a Device</p>
        <img src="${qrImageUrl}" style="width:300px;height:300px;border:4px solid #309898;border-radius:16px;" />
        <p style="color:#bbb;margin-top:16px;font-size:13px;">QR code expires in 60 seconds — page refreshes automatically</p>
        <script>setTimeout(() => location.reload(), 15000)</script>
      </body>
    </html>
  `);
});

// GET /restart — force reconnect
app.get('/restart', async (req, res) => {
  console.log('[WA] Manual restart requested');
  isReady = false;
  qrCodeData = null;
  lastError = null;

  if (sock) {
    try { await sock.logout(); } catch (_) {}
    sock = null;
  }

  setTimeout(startClient, 1000);
  res.json({ status: 'restarting' });
});

// POST /send — send WhatsApp message
app.post('/send', authenticate, async (req, res) => {
  if (!isReady || !sock) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }

  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message are required' });
  }

  try {
    const jid = formatPhone(phone);
    
    await sock.sendMessage(jid, { text: message });

    console.log(`[SENT] ✅ To: ${jid}`);
    res.json({ success: true, to: jid });
  } catch (err) {
    console.error('[SEND ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Keep-alive ping
const RENDER_URL = process.env.RENDER_URL;
if (RENDER_URL) {
  setInterval(async () => {
    try {
      await fetch(`${RENDER_URL}/status`);
      console.log('[KEEPALIVE] ✅ Pinged successfully');
    } catch (err) {
      console.log('[KEEPALIVE] ❌ Ping failed:', err.message);
    }
  }, 10 * 60 * 1000);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ CrewFund WhatsApp server running on port ${PORT}`);
  startClient();
});