const wppconnect = require('@wppconnect-team/wppconnect');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

let client = null;
let qrCodeData = null;
let isReady = false;

const API_SECRET = process.env.API_SECRET || 'crewfund-secret-key';

// Middleware to check API secret
function authenticate(req, res, next) {
  const secret = req.headers['x-api-secret'];
  if (secret !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Initialize WPPConnect
async function startClient() {
  try {
    client = await wppconnect.create({
      session: 'crewfund',
      catchQR: (base64Qr) => {
        qrCodeData = base64Qr;
        isReady = false;
        console.log('QR Code generated — scan it at /qr');
      },
      statusFind: (statusSession) => {
        console.log('Status:', statusSession);
        if (statusSession === 'isLogged' || statusSession === 'qrReadSuccess') {
          isReady = true;
          qrCodeData = null;
          console.log('WhatsApp connected and ready');
        }
      },
      headless: true,
      devtools: false,
      useChrome: false,
      debug: false,
      logQR: false,
      browserWS: '',
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ],
      puppeteerOptions: {},
      disableWelcome: true,
      updatesLog: false,
      autoClose: 0,
      tokenStore: 'file',
      folderNameToken: './tokens',
    });

    console.log('WPPConnect client created');
  } catch (err) {
    console.error('Error starting client:', err);
    setTimeout(startClient, 5000);
  }
}

// GET /qr — show QR code to scan
app.get('/qr', (req, res) => {
  if (isReady) {
    return res.json({ status: 'connected', message: 'WhatsApp already connected' });
  }
  if (!qrCodeData) {
    return res.json({ status: 'waiting', message: 'QR not ready yet — try again in a few seconds' });
  }
  res.send(`
    <html>
      <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#FAF8F5;font-family:sans-serif;">
        <h2 style="color:#309898;margin-bottom:24px;">Scan this QR code with WhatsApp</h2>
        <img src="${qrCodeData}" style="width:300px;height:300px;border:4px solid #309898;border-radius:16px;" />
        <p style="color:#888;margin-top:16px;">Open WhatsApp → Linked Devices → Link a Device</p>
        <p style="color:#888;">Page auto-refreshes every 10 seconds</p>
        <script>setTimeout(() => location.reload(), 10000)</script>
      </body>
    </html>
  `);
});

// GET /status — check connection status
app.get('/status', (req, res) => {
  res.json({
    connected: isReady,
    hasQR: !!qrCodeData,
  });
});

// POST /send — send a WhatsApp message
app.post('/send', authenticate, async (req, res) => {
  if (!isReady || !client) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }

  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message are required' });
  }

  try {
    // Format Nigerian number
    let formatted = phone.replace(/\s+/g, '').replace(/-/g, '');
    if (formatted.startsWith('+')) formatted = formatted.slice(1);
    if (formatted.startsWith('0')) formatted = '234' + formatted.slice(1);
    if (!formatted.startsWith('234')) formatted = '234' + formatted;

    const chatId = `${formatted}@c.us`;

    await client.sendText(chatId, message);

    console.log(`[SENT] To: ${formatted}`);
    res.json({ success: true, to: formatted });
  } catch (err) {
    console.error('[SEND ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    service: 'CrewFund WhatsApp Server',
    status: isReady ? 'connected' : 'disconnected',
    version: '1.0.0'
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`CrewFund WhatsApp server running on port ${PORT}`);
  startClient();
});