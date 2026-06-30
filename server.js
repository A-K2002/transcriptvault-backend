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

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

app.listen(PORT, () => {
  console.log(`TranscriptVault backend running on port ${PORT}`);
});
