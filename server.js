// server/server.js
//
// The backend behind AdaptPractice.
// Supports running as a standalone Node server or as a Vercel Serverless Function.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const { askText, askJSON, streamText, MODEL, getHealth } = require('./claude');

const app = express();
const PORT = process.env.PORT || 8787;
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_PROMPT_CHARS = 40000;

app.use(express.json({ limit: '4mb' }));

app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED.length === 0 || ALLOWED.includes(origin)) return cb(null, true);
    cb(new Error('Origin not allowed: ' + origin));
  }
}));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Wait a minute and try again.' }
}));

const APP_ROOT = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
app.use(express.static(APP_ROOT, { index: false }));
app.get(/^(?!\/api\/).*$/, (req, res, next) => {
  const pathname = req.path || '/';
  if (/\.[A-Za-z0-9]+$/.test(pathname) || pathname.startsWith('/_')) return next();
  res.sendFile(path.join(APP_ROOT, 'index.html'));
});

function bad(res, status, message, code) {
  return res.status(status).json({ error: message, ...(code ? { code } : {}) });
}

function aiFailure(err) {
  const message = String((err && err.message) || '');
  if (/credit balance is too low|purchase credits|plans?\s*&?\s*billing/i.test(message)) {
    return { status: 402, code: 'credits_exhausted', message: 'Your Anthropic API account has no available credit. Add credit in Anthropic Console → Plans & Billing, then try again.' };
  }
  if (/no.*key.*configured|missing.*key|set anthropic_api_key/i.test(message)) {
    return { status: 400, code: 'missing_api_key', message: 'No AI API key is configured. Add ANTHROPIC_API_KEY or GEMINI_API_KEY in Vercel environment variables or enter it in Settings.' };
  }
  if (/authentication_error|invalid.*api key|api[_ ]key/i.test(message)) {
    return { status: 401, code: 'invalid_api_key', message: 'The AI API key was rejected. Please verify your API key.' };
  }
  if (/not_found_error|model.*not found|unknown model/i.test(message)) {
    return { status: 400, code: 'invalid_model', message: 'The configured AI model is unavailable. Update the model name in your environment.' };
  }
  if (/overloaded_error|overloaded/i.test(message)) {
    return { status: 529, code: 'provider_overloaded', message: 'The AI provider is temporarily overloaded. Please retry in a moment.' };
  }
  return { status: 502, code: 'upstream_error', message: message || 'The AI provider could not complete the request. Please try again.' };
}

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch(err => {
    console.error(err);
    const failure = aiFailure(err);
    bad(res, failure.status, failure.message, failure.code);
  });
}

function readPrompt(req, res) {
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string') { bad(res, 400, 'prompt is required'); return null; }
  if (prompt.length > MAX_PROMPT_CHARS) { bad(res, 413, 'That request is too long.'); return null; }
  return prompt;
}

function readCustomKey(req) {
  const header = req.headers['x-api-key'] || req.headers['authorization'];
  if (!header) return null;
  return header.replace(/^Bearer\s+/i, '').trim() || null;
}

const YT_DLP_CANDIDATES = [
  process.env.YT_DLP_PATH,
  '/Users/vinayak/Library/Python/3.9/bin/yt-dlp',
  '/opt/homebrew/bin/yt-dlp',
  '/usr/local/bin/yt-dlp'
].filter(Boolean);

const YT_DLP_PATH = YT_DLP_CANDIDATES.find(candidate => {
  try { return fs.existsSync(candidate); } catch (e) { return false; }
}) || (process.env.VERCEL ? null : 'yt-dlp');

function getPlaylistItems(url) {
  return new Promise((resolve, reject) => {
    if (!YT_DLP_PATH) {
      return reject(new Error('Automated playlist fetching requires yt-dlp. On the web version, please paste your playlist video titles directly into the box.'));
    }
    execFile(YT_DLP_PATH, ['--flat-playlist', '--print', '%(playlist_index)s|%(title)s|%(id)s|%(duration)s|%(url)s', url], { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim() || 'Could not read that YouTube playlist.';
        return reject(new Error(msg));
      }
      const items = [];
      for (const line of String(stdout || '').split(/\r?\n/)) {
        const row = line.trim();
        if (!row) continue;
        const parts = row.split('|');
        if (parts.length < 5) continue;
        const index = Number(parts[0]);
        const title = parts.slice(1, -3).join('|').trim();
        const videoId = parts[parts.length - 3];
        const duration = parts[parts.length - 2];
        const watchUrl = parts[parts.length - 1];
        if (!title || !watchUrl) continue;
        items.push({ index: Number.isFinite(index) ? index : items.length + 1, title, id: videoId, duration, url: watchUrl });
      }
      if (!items.length) return reject(new Error('No videos were found in that playlist. You can paste the lesson titles directly.'));
      resolve(items);
    });
  });
}

app.get(['/api/health', '/health', '/api'], (req, res) => res.json(getHealth()));

app.get(['/api/playlist', '/playlist'], asyncRoute(async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return bad(res, 400, 'A YouTube playlist URL is required.');
  const items = await getPlaylistItems(url);
  res.json({ ok: true, items });
}));

app.post(['/api/ai/text', '/ai/text'], asyncRoute(async (req, res) => {
  const prompt = readPrompt(req, res); if (prompt === null) return;
  const customKey = readCustomKey(req);
  const text = await askText(prompt, 1500, customKey);
  res.json({ text });
}));

app.post(['/api/ai/json', '/ai/json'], asyncRoute(async (req, res) => {
  const prompt = readPrompt(req, res); if (prompt === null) return;
  const customKey = readCustomKey(req);
  const out = await askJSON(prompt, 3500, customKey);
  res.json(out);
}));

app.post(['/api/ai/stream', '/ai/stream'], (req, res) => {
  const prompt = readPrompt(req, res); if (prompt === null) return;
  const customKey = readCustomKey(req);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let done = false;
  const finish = (line) => {
    if (done || res.writableEnded) return;
    done = true;
    try { res.write(line); res.end(); } catch (e) {}
  };
  req.on('close', () => { done = true; });

  try {
    streamText(prompt, {
      maxTokens: 700,
      onDelta: (delta) => { if (!done && !res.writableEnded) res.write(`data: ${JSON.stringify({ delta })}\n\n`); },
      onEnd: () => finish('data: [DONE]\n\n'),
      onError: (err) => {
        console.error('stream error:', err.message || err);
        const failure = aiFailure(err);
        finish(`data: ${JSON.stringify({ error: failure.message })}\n\n`);
      }
    }, customKey);
  } catch (err) {
    console.error(err);
    const failure = aiFailure(err);
    finish(`data: ${JSON.stringify({ error: failure.message })}\n\n`);
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AdaptPractice running: http://localhost:${PORT}`);
    console.log(`Health: ${JSON.stringify(getHealth())}`);
    if (!ALLOWED.length) console.log('ALLOWED_ORIGINS is empty — every origin is currently allowed.');
  });
}

module.exports = app;
