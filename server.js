const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB
});

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'TranscriptVault backend running' });
});

// Convert to compressed mp3 using ffmpeg spawn (more memory-safe than exec)
function convertToMp3(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath + '_converted.mp3';
    const ffmpeg = spawn('ffmpeg', [
      '-i', inputPath,
      '-vn',              // no video
      '-ar', '16000',     // lower sample rate = smaller file, Whisper-friendly
      '-ac', '1',          // mono
      '-b:a', '64k',       // lower bitrate = smaller file
      '-f', 'mp3',
      '-y',
      outputPath
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });

    ffmpeg.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        reject(new Error('ffmpeg conversion failed: ' + stderr.slice(-300)));
      }
    });

    ffmpeg.on('error', (err) => reject(err));
  });
}

app.post('/transcribe', upload.single('file'), async (req, res) => {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return res.status(500).json({ error: 'OpenAI API key not configured.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const originalName = req.file.originalname || 'audio.mp4';
  const ext = originalName.split('.').pop().toLowerCase();
  const nativeFormats = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm'];

  let filePath = req.file.path;
  let convertedPath = null;
  let filename = 'audio.mp3';
  let mimeType = 'audio/mpeg';

  try {
    // Always compress to mp3 to guarantee we stay under Whisper's 25MB limit
    convertedPath = await convertToMp3(filePath);
    filePath = convertedPath;

    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), {
      filename: filename,
      contentType: mimeType,
    });
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Whisper API error' });
    }

    const segments = (data.segments || []).map(seg => ({
      time: formatTime(seg.start),
      text: seg.text.trim(),
    }));

    res.json({
      segments: segments.length ? segments : [{ time: '0:00', text: data.text || '' }],
      word_count: data.text ? data.text.split(' ').length : 0,
      duration_estimate: data.segments?.length ? formatTime(data.segments[data.segments.length - 1].end) : '—',
      language: data.language || 'Auto',
      full_text: data.text,
    });

  } catch (err) {
    console.error('Transcription error:', err.message);
    res.status(500).json({ error: err.message || 'Transcription failed.' });
  } finally {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    if (convertedPath) fs.unlink(convertedPath, () => {});
  }
});

// ── GET VIDEO INFO ──
app.get('/info', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const ytdlp = spawn('yt-dlp', ['--dump-json', '--no-playlist', url]);
  let stdout = '';
  let stderr = '';
  ytdlp.stdout.on('data', d => stdout += d.toString());
  ytdlp.stderr.on('data', d => stderr += d.toString());

  ytdlp.on('close', (code) => {
    if (code !== 0) {
      return res.status(400).json({ error: 'Could not fetch video info. The URL may not be supported.' });
    }
    try {
      const info = JSON.parse(stdout.trim().split('\n')[0]);
      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration_string || info.duration,
        uploader: info.uploader,
        platform: info.extractor_key,
      });
    } catch {
      res.status(500).json({ error: 'Failed to parse video info.' });
    }
  });
});

// ── DOWNLOAD VIDEO (any platform via yt-dlp) ──
app.get('/download', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const tmpDir = os.tmpdir();
  const outputTemplate = path.join(tmpDir, `dl_${Date.now()}.%(ext)s`);

  const ytdlp = spawn('yt-dlp', [
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--no-playlist',
    '--print', 'after_move:filepath',
    '-o', outputTemplate,
    url
  ]);

  let stdout = '';
  let stderr = '';
  ytdlp.stdout.on('data', d => stdout += d.toString());
  ytdlp.stderr.on('data', d => stderr += d.toString());

  ytdlp.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp download error:', stderr.slice(-500));
      return res.status(400).json({ error: 'Download failed. The URL may not be supported or the video is private.' });
    }

    const filePath = stdout.trim().split('\n').pop();
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(500).json({ error: 'Downloaded file not found.' });
    }

    const filename = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'video/mp4');

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('end', () => fs.unlink(filePath, () => {}));
    stream.on('error', () => res.status(500).json({ error: 'Failed to stream file.' }));
  });
});

// ── TRANSCRIBE FROM URL (download then transcribe via Whisper) ──
app.get('/transcribe-url', async (req, res) => {
  const url = req.query.url;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!openaiKey) return res.status(500).json({ error: 'OpenAI API key not configured.' });

  const tmpDir = os.tmpdir();
  const outputTemplate = path.join(tmpDir, `url_${Date.now()}.%(ext)s`);

  // Download audio-only for speed
  const ytdlp = spawn('yt-dlp', [
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'mp3', '--audio-quality', '5',
    '--no-playlist',
    '--print', 'after_move:filepath',
    '-o', outputTemplate,
    url
  ]);

  let stdout = '';
  let stderr = '';
  ytdlp.stdout.on('data', d => stdout += d.toString());
  ytdlp.stderr.on('data', d => stderr += d.toString());

  ytdlp.on('close', async (code) => {
    if (code !== 0) {
      console.error('yt-dlp error:', stderr.slice(-500));
      return res.status(400).json({ error: 'Could not download from this URL. It may not be supported or the content may be private.' });
    }

    const filePath = stdout.trim().split('\n').pop();
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(500).json({ error: 'Downloaded audio not found.' });
    }

    try {
      const form = new FormData();
      form.append('file', fs.createReadStream(filePath), {
        filename: 'audio.mp3',
        contentType: 'audio/mpeg',
      });
      form.append('model', 'whisper-1');
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiKey}`, ...form.getHeaders() },
        body: form,
      });

      const data = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({ error: data.error?.message || 'Whisper API error' });
      }

      const segments = (data.segments || []).map(seg => ({
        time: formatTime(seg.start),
        text: seg.text.trim(),
      }));

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
      fs.unlink(filePath, () => {});
    }
  });
});

// ── STRIPE CHECKOUT ──
app.post('/create-checkout-session', express.json(), async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Stripe not configured on server.' });

  const { priceId, successUrl, cancelUrl } = req.body;
  if (!priceId || !successUrl || !cancelUrl) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
    const params = new URLSearchParams();
    params.append('mode', 'subscription');
    params.append('line_items[0][price]', priceId);
    params.append('line_items[0][quantity]', '1');
    params.append('success_url', successUrl);
    params.append('cancel_url', cancelUrl);

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Stripe error' });
    }

    res.json({ url: data.url });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Checkout session creation failed.' });
  }
});

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

app.listen(PORT, () => {
  console.log(`TranscriptVault backend running on port ${PORT}`);
});
