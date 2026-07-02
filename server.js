const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 200 * 1024 * 1024 } });

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PATCH'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

const SUPABASE_URL = () => process.env.SUPABASE_URL;
const SUPABASE_KEY = () => process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = () => process.env.RESEND_API_KEY;
const OPENAI_KEY = () => process.env.OPENAI_API_KEY;
const STRIPE_SECRET = () => process.env.STRIPE_SECRET_KEY;
const SITE_URL = () => process.env.SITE_URL || 'https://thetranscriptvault.com';

async function db(method, endpoint, body) {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY(),
      'Authorization': `Bearer ${SUPABASE_KEY()}`,
      'Prefer': method === 'POST' ? 'return=representation' : 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

app.get('/', (req, res) => res.json({ status: 'TranscriptVault backend running' }));

// ── SEND 6-DIGIT CODE ──
app.post('/auth/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  try {
    // Delete old codes for this email
    await db('DELETE', `/verify_codes?email=eq.${encodeURIComponent(email)}`, null);
    // Insert new code
    await db('POST', '/verify_codes', { email, code, expires_at });

    // Send email
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY()}` },
      body: JSON.stringify({
        from: 'TranscriptVault <noreply@thetranscriptvault.com>',
        to: email,
        subject: 'Your TranscriptVault verification code',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;">
            <h2 style="color:#111;margin-bottom:8px;">Your verification code</h2>
            <p style="color:#555;margin-bottom:24px;">Enter this code on TranscriptVault to sign in:</p>
            <div style="background:#f4f4f4;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
              <span style="font-size:42px;font-weight:800;letter-spacing:12px;color:#111;">${code}</span>
            </div>
            <p style="color:#999;font-size:13px;">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
          </div>
        `,
      }),
    });

    if (!emailRes.ok) {
      const err = await emailRes.json();
      return res.status(500).json({ error: 'Failed to send email: ' + (err.message || 'Unknown') });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to send code.' });
  }
});

// ── VERIFY CODE ──
app.post('/auth/verify-code', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required.' });

  try {
    const codes = await db('GET', `/verify_codes?email=eq.${encodeURIComponent(email)}&code=eq.${code}&select=*`);
    if (!Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({ error: 'Invalid code. Please try again.' });
    }
    if (new Date(codes[0].expires_at) < new Date()) {
      return res.status(400).json({ error: 'Code expired. Please request a new one.' });
    }

    // Delete used code
    await db('DELETE', `/verify_codes?email=eq.${encodeURIComponent(email)}`, null);

    // Check if user exists
    const users = await db('GET', `/users?email=eq.${encodeURIComponent(email)}&select=*`);
    const isNewUser = !Array.isArray(users) || users.length === 0;
    let user = isNewUser ? null : users[0];

    if (isNewUser) {
      const created = await db('POST', '/users', { email, is_pro: false });
      user = Array.isArray(created) ? created[0] : created;
    }

    // Create session
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await db('POST', '/sessions', { email, token: sessionToken, expires_at });

    res.json({
      success: true,
      session_token: sessionToken,
      email: user.email,
      username: user.username || null,
      is_pro: user.is_pro,
      is_new_user: isNewUser || !user.username,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Verification failed.' });
  }
});

// ── SET USERNAME ──
app.post('/auth/set-username', async (req, res) => {
  const { session_token, username } = req.body;
  if (!session_token || !username) return res.status(400).json({ error: 'Session and username required.' });

  const clean = username.trim().replace(/[^a-zA-Z0-9_]/g, '');
  if (clean.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters (letters, numbers, underscore only).' });

  try {
    const sessions = await db('GET', `/sessions?token=eq.${session_token}&select=*`);
    if (!Array.isArray(sessions) || sessions.length === 0) return res.status(401).json({ error: 'Invalid session.' });

    // Check username not taken
    const existing = await db('GET', `/users?username=eq.${encodeURIComponent(clean)}&select=*`);
    if (Array.isArray(existing) && existing.length > 0) {
      return res.status(400).json({ error: 'Username already taken. Please choose another.' });
    }

    await db('PATCH', `/users?email=eq.${encodeURIComponent(sessions[0].email)}`, { username: clean });
    res.json({ success: true, username: clean });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET SESSION ──
app.post('/auth/session', async (req, res) => {
  const { session_token } = req.body;
  if (!session_token) return res.status(401).json({ error: 'No session.' });

  try {
    const sessions = await db('GET', `/sessions?token=eq.${session_token}&select=*`);
    if (!Array.isArray(sessions) || sessions.length === 0) return res.status(401).json({ error: 'Invalid session.' });
    if (new Date(sessions[0].expires_at) < new Date()) return res.status(401).json({ error: 'Session expired.' });

    const users = await db('GET', `/users?email=eq.${encodeURIComponent(sessions[0].email)}&select=*`);
    const user = Array.isArray(users) ? users[0] : null;
    if (!user) return res.status(401).json({ error: 'User not found.' });

    res.json({ email: user.email, username: user.username, is_pro: user.is_pro });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE CHECKOUT ──
app.post('/create-checkout-session', async (req, res) => {
  const { priceId, successUrl, cancelUrl, email } = req.body;
  try {
    const params = new URLSearchParams();
    params.append('mode', 'subscription');
    params.append('line_items[0][price]', priceId);
    params.append('line_items[0][quantity]', '1');
    params.append('success_url', successUrl);
    params.append('cancel_url', cancelUrl);
    if (email) params.append('customer_email', email);

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message });
    res.json({ url: data.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE PORTAL ──
app.post('/create-portal-session', async (req, res) => {
  const { session_token } = req.body;
  try {
    const sessions = await db('GET', `/sessions?token=eq.${session_token}&select=*`);
    if (!Array.isArray(sessions) || sessions.length === 0) return res.status(401).json({ error: 'Invalid session.' });
    const users = await db('GET', `/users?email=eq.${encodeURIComponent(sessions[0].email)}&select=*`);
    const user = Array.isArray(users) ? users[0] : null;
    if (!user?.stripe_customer_id) return res.status(400).json({ error: 'No subscription found.' });

    const params = new URLSearchParams();
    params.append('customer', user.stripe_customer_id);
    params.append('return_url', SITE_URL());

    const response = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message });
    res.json({ url: data.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE WEBHOOK ──
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    const stripe = require('stripe')(STRIPE_SECRET());
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_email || session.customer_details?.email;
      if (email) {
        await db('PATCH', `/users?email=eq.${encodeURIComponent(email)}`, {
          is_pro: true,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
        });
      }
    }
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await db('PATCH', `/users?stripe_customer_id=eq.${sub.customer}`, { is_pro: false });
    }
    res.json({ received: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── TRANSCRIBE ──
function convertToMp3(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath + '_converted.mp3';
    const ffmpeg = spawn('ffmpeg', ['-i', inputPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k', '-f', 'mp3', '-y', outputPath]);
    let stderr = '';
    ffmpeg.stderr.on('data', d => stderr += d.toString());
    ffmpeg.on('close', code => { if (code === 0 && fs.existsSync(outputPath)) resolve(outputPath); else reject(new Error('ffmpeg failed')); });
    ffmpeg.on('error', reject);
  });
}

app.post('/transcribe', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  let filePath = req.file.path, convertedPath = null;
  try {
    convertedPath = await convertToMp3(filePath);
    filePath = convertedPath;
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${OPENAI_KEY()}`, ...form.getHeaders() }, body: form,
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message });
    const segments = (data.segments || []).map(seg => ({ time: formatTime(seg.start), text: seg.text.trim() }));
    res.json({ segments: segments.length ? segments : [{ time: '0:00', text: data.text }], word_count: data.text?.split(' ').length || 0, duration_estimate: data.segments?.length ? formatTime(data.segments[data.segments.length - 1].end) : '—', language: data.language || 'Auto', full_text: data.text });
  } catch (err) { res.status(500).json({ error: err.message }); }
  finally { if (req.file?.path) fs.unlink(req.file.path, () => {}); if (convertedPath) fs.unlink(convertedPath, () => {}); }
});

function formatTime(s) { return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`; }

app.listen(PORT, () => console.log(`TranscriptVault backend running on port ${PORT}`));
