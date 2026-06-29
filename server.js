const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ 
  dest: os.tmpdir(),
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'TranscriptVault backend running' });
});

// Convert any video to mp3 using ffmpeg
function convertToMp3(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath + '.mp3';
    exec(`ffmpeg -i "${inputPath}" -vn -ar 44100 -ac 2 -b:a 192k "${outputPath}" -y`, (err) => {
      if (err) reject(err);
      else resolve(outputPath);
    });
  });
}

app.post('/transcribe', upload.single('file'), async (req, res) => {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return res.status(500).json({ error: 'OpenAI API key not configured.' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const supportedFormats = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm'];
  const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
  
  let filePath = req.file.path;
  let convertedPath = null;

  try {
    // Convert unsupported formats to mp3 using ffmpeg
    if (!supportedFormats.includes(ext)) {
      convertedPath = await convertToMp3(filePath);
      filePath = convertedPath;
    }

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

    const wordCount = data.text ? data.text.split(' ').length : 0;
    const duration = data.segments?.length
      ? formatTime(data.segments[data.segments.length - 1].end)
      : '—';

    res.json({
      segments,
      word_count: wordCount,
      duration_estimate: duration,
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

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

app.listen(PORT, () => {
  console.log(`TranscriptVault backend running on port ${PORT}`);
});
