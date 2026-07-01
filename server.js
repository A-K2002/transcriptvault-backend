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
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024 }
});

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());

// ── ENV VARS ──
const OPENAI_KEY = () => process.env.OPENAI_API_KEY;
const STRIPE_SECRET = () => process.env.STRIPE_SECRET_KEY;
const SUPABASE_URL = () => process.env.SUPABASE_URL;
const SUPABASE_KEY = () => process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = () => process.env.RESEND_API_KEY;
const SITE_URL = () => process.env.SITE_URL || 'https://thetranscriptvault.com';

// ── SUPABASE HELPERS ──
async function supabase(method, path, body) {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY(),
      'Authorization': `Bearer ${SUPABASE_KEY()}`,
      'Prefer': method === 'POST' ? 'return=representation' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.json({ status: 'TranscriptVault backend running' }));

// ── SEND MAGIC LINK ──
app.post('/auth/send-magic-link', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  try {
    // Create or find user
    let users = await supabase('GET', `/users?email=eq.${encodeURIComponent(email)}&select=*`);
    let user;
    if (!Array.isArray(users) || users.length === 0) {
      const created = await supabase('POST', '/users', { email, is_pro: false });
      user = Array.isArray(created) ? created[0] : created;
    } else {
      user = users[0];
    }

    // Generate magic link token
    const token = crypto.randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min expiry

    await supabase('POST', '/magic_links', { email, token, expires_at, used: false });

    const magicUrl = `${SITE_URL()}?magic_token=${token}`;

    // Send email via Resend
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_KEY()}`,
      },
      body: JSON.stringify({
        from: 'TranscriptVault <noreply@thetranscriptvault.com>',
        to: email,
        subject: 'Your TranscriptVault login link',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;">
            <h2 style="color:#111;">Sign in to TranscriptVault</h2>
            <p style="color:#555;">Click the button below to sign in. This link expires in 15 minutes.</p>
            <a href="${magicUrl}" style="display:inline-block;background:#4F8EF7;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">Sign in to TranscriptVault</a>
            <p style="color:#999;font-size:12px;">If you didn't request this, you can ignore this email.</p>
          </div>
        `,
      }),
    });

    if (!emailRes.ok) {
      const err = await emailRes.json();
      return res.status(500).json({ error: 'Failed to send email: ' + (err.message || 'Unknown error') });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to send magic link.' });
  }
});

// ── VERIFY MAGIC LINK ──
app.post('/auth/verify-magic-link', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required.' });

  try {
    const links = await supabase('GET', `/magic_links?token=eq.${token}&used=eq.false&select=*`);
    if (!Array.isArray(links) || links.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired login link.' });
    }

    const link = links[0];
    if (new Date(link.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This login link has expired. Please request a new one.' });
    }

    // Mark token as used
    await supabase('PATCH', `/magic_links?token=eq.${token}`, { used: true });

    // Get user
    const users = await supabase('GET', `/users?email=eq.${encodeURIComponent(link.email)}&select=*`);
    const user = Array.isArray(users) ? users[0] : null;
    if (!user) return res.status(400).json({ error: 'User not found.' });

    // Generate session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const session_expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

    await supabase('POST', '/sessions', { email: user.email, token: sessionToken, expires_at: session_expires });

    res.json({ success: true, session_token: sessionToken, email: user.email, is_pro: user.is_pro });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Verification failed.' });
  }
});

// ── GET SESSION (verify logged in) ──
app.post('/auth/session', async (req, res) => {
  const { session_token } = req.body;
  if (!session_token) return res.status(401).json({ error: 'No session token.' });

  try {
    const sessions = await supabase('GET', `/sessions?token=eq.${session_token}&select=*`);
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return res.status(401).json({ error: 'Invalid session.' });
    }

    const session = sessions[0];
    if (new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Session expired.' });
    }

    const users = await supabase('GET', `/users?email=eq.${encodeURIComponent(session.email)}&select=*`);
    const user = Array.isArray(users) ? users[0] : null;
    if (!user) return res.status(401).json({ error: 'User not found.' });

    res.json({ email: user.email, is_pro: user.is_pro });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Session check failed.' });
  }
});

// ── STRIPE CHECKOUT ──
app.post('/create-checkout-session', async (req, res) => {
  const { priceId, successUrl, cancelUrl, email } = req.body;
  if (!priceId) return res.status(400).json({ error: 'Missing price ID.' });

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
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Stripe error' });
    res.json({ url: data.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE WEBHOOK (mark user as Pro after payment) ──
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const stripe = require('stripe')(STRIPE_SECRET());
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    return res.status(400).json({ error: 'Webhook signature verification failed.' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email || session.customer_details?.email;
    if (email) {
      await supabase('PATCH', `/users?email=eq.${encodeURIComponent(email)}`, {
        is_pro: true,
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
      });
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const customers = await supabase('GET', `/users?stripe_customer_id=eq.${sub.customer}&select=*`);
    if (Array.isArray(customers) && customers.length > 0) {
      await supabase('PATCH', `/users?stripe_customer_id=eq.${sub.customer}`, { is_pro: false });
    }
  }

  res.json({ received: true });
});

// ── STRIPE PORTAL (manage/cancel subscription) ──
app.post('/create-portal-session', async (req, res) => {
  const { session_token } = req.body;
  if (!session_token) return res.status(401).json({ error: 'Not logged in.' });

  try {
    const sessions = await supabase('GET', `/sessions?token=eq.${session_token}&select=*`);
    if (!Array.isArray(sessions) || sessions.length === 0) return res.status(401).json({ error: 'Invalid session.' });

    const users = await supabase('GET', `/users?email=eq.${encodeURIComponent(sessions[0].email)}&select=*`);
    const user = Array.isArray(users) ? users[0] : null;
    if (!user?.stripe_customer_id) return res.status(400).json({ error: 'No subscription found.' });

    const params = new URLSearchParams();
    params.append('customer', user.stripe_customer_id);
    params.append('return_url', SITE_URL());

    const response = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message });
    res.json({ url: data.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TRANSCRIBE ──
function convertToMp3(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath + '_converted.mp3';
    const ffmpeg = spawn('ffmpeg', ['-i', inputPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k', '-f', 'mp3', '-y', outputPath]);
    let stderr = '';
    ffmpeg.stderr.on('data', d => stderr += d.toString());
    ffmpeg.on('close', code => {
      if (code === 0 && fs.existsSync(outputPath)) resolve(outputPath);
      else reject(new Error('ffmpeg conversion failed'));
    });
    ffmpeg.on('error', err => reject(err));
  });
}

app.post('/transcribe', upload.single('file'), async (req, res) => {
  const openaiKey = OPENAI_KEY();
  if (!openaiKey) return res.status(500).json({ error: 'OpenAI API key not configured.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  let filePath = req.file.path;
  let convertedPath = null;

  try {
    convertedPath = await convertToMp3(filePath);
    filePath = convertedPath;

    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}`, ...form.getHeaders() },
      body: form,
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Whisper API error' });

    const segments = (data.segments || []).map(seg => ({ time: formatTime(seg.start), text: seg.text.trim() }));
    res.json({
      segments: segments.length ? segments : [{ time: '0:00', text: data.text || '' }],
      word_count: data.text ? data.text.split(' ').length : 0,
      duration_estimate: data.segments?.length ? formatTime(data.segments[data.segments.length - 1].end) : '—',
      language: data.language || 'Auto',
      full_text: data.text,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Transcription failed.' });
  } finally {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    if (convertedPath) fs.unlink(convertedPath, () => {});
  }
});

// ── TRANSCRIBE FROM URL ──
app.get('/transcribe-url', async (req, res) => {
  const url = req.query.url;
  const openaiKey = OPENAI_KEY();
  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!openaiKey) return res.status(500).json({ error: 'OpenAI API key not configured.' });

  const tmpDir = os.tmpdir();
  const outputTemplate = path.join(tmpDir, `url_${Date.now()}.%(ext)s`);

  const ytdlp = spawn('yt-dlp', ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '5', '--no-playlist', '--print', 'after_move:filepath', '-o', outputTemplate, url]);
  let stdout = '';
  ytdlp.stdout.on('data', d => stdout += d.toString());
  ytdlp.on('close', async code => {
    if (code !== 0) return res.status(400).json({ error: 'Could not download from this URL.' });
    const filePath = stdout.trim().split('\n').pop();
    if (!filePath || !fs.existsSync(filePath)) return res.status(500).json({ error: 'Downloaded audio not found.' });

    try {
      const form = new FormData();
      form.append('file', fs.createReadStream(filePath), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
      form.append('model', 'whisper-1');
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiKey}`, ...form.getHeaders() },
        body: form,
      });

      const data = await response.json();
      if (!response.ok) return res.status(response.status).json({ error: data.error?.message });

      const segments = (data.segments || []).map(seg => ({ time: formatTime(seg.start), text: seg.text.trim() }));
      res.json({
        segments: segments.length ? segments : [{ time: '0:00', text: data.text || '' }],
        word_count: data.text ? data.text.split(' ').length : 0,
        duration_estimate: data.segments?.length ? formatTime(data.segments[data.segments.length - 1].end) : '—',
        language: data.language || 'Auto',
        full_text: data.text,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      fs.unlink(filePath, () => {});
    }
  });
});

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

app.listen(PORT, () => console.log(`TranscriptVault backend running on port ${PORT}`));
