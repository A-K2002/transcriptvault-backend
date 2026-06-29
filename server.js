const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ 
  dest: os.tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'TranscriptVault backend running' });
});

app.post('/transcribe', upload.single('file'), async (req, res) => {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return res.status(500).json({ error: 'OpenAI API key not configured.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const originalName = req.file.originalname || 'audio.mp4';
  const ext = originalName.split('.').pop().toLowerCase();

  // Map extensions to mime types Whisper accepts
  const mimeMap = {
    mp4: 'video/mp4', mov: 'video/mp4', avi: 'video/mp4',
    mkv: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
    m4a: 'audio/mp4', wav: 'audio/wav', flac: 'audio/flac',
    ogg: 'audio/ogg', oga: 'audio/ogg', mpga: 'audio/mpeg',
  };
  const mimeType = mimeMap[ext] || 'video/mp4';
  const filename = `audio.${ext === 'mov' || ext === 'avi' || ext === 'mkv' ? 'mp4' : ext}`;

  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(req.file.path), {
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
    res.status(500).json({ error: err.message || 'Transcription failed.' });
  } finally {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
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
