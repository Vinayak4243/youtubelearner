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
const { createClient } = require('@supabase/supabase-js');
const { authenticateRequest, hasSupabaseConfig, getSupabaseConfig, sessionCookies, cookieValues, createUserClient } = require('./server/auth');

const { askText, askJSON, streamText, MODEL, getHealth, checkProviderStatus } = require('./ai');

const app = express();
const PORT = process.env.PORT || 8787;
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_PROMPT_CHARS = 200000;
app.set('trust proxy', 1);

app.use(express.json({ limit: '4mb' }));

app.use((req, res, next) => {
  if (process.env.VERCEL && /^\/(?:auth|learner)(?:\/|$)/.test(req.path)) req.url = '/api' + req.url;
  next();
});

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, false);
    cb(null, ALLOWED.includes(origin));
  },
  credentials: true
}));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Wait a minute and try again.' }
}));

app.use('/api/auth/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Try again later.', code: 'rate_limited' }
}));

const userAiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: req => req.user.id,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests. Wait a minute and try again.', code: 'rate_limited' }
});

async function persistentUserAiRateLimit(req, res, next) {
  try {
    const { data, error } = await req.userSupabase.rpc('consume_user_ai_rate_limit', { max_requests:20 });
    if (error) {
      console.error('Persistent AI rate limit unavailable:', error.code || 'database_error');
      return bad(res, 503, 'AI requests are temporarily unavailable because the account rate limit could not be checked.', 'database_unavailable');
    }
    if (data !== true) return bad(res, 429, 'Too many AI requests. Wait a minute and try again.', 'rate_limited');
    next();
  } catch (error) {
    console.error('Persistent AI rate limit unavailable:', error.code || 'database_error');
    return bad(res, 503, 'AI requests are temporarily unavailable because the account rate limit could not be checked.', 'database_unavailable');
  }
}

app.use('/api/auth/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Try again later.', code: 'rate_limited' }
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

function classifySignupFailure(error) {
  const message = String(error?.message || '').toLowerCase();
  const providerCode = String(error?.code || '').toLowerCase();
  if (providerCode.includes('rate_limit') || /rate limit|email rate limit/.test(message)) {
    return { status:429, code:'signup_rate_limited', category:'email_rate_limit', message:'Too many signup or confirmation-email requests. Wait a while and try again.' };
  }
  if (/signup_disabled|email_provider_disabled/.test(providerCode) || /signups? (are|is) disabled|email provider.*disabled/.test(message)) {
    return { status:503, code:'signup_unavailable', category:'signup_disabled', message:'Account registration is unavailable. Please contact the site owner.' };
  }
  if (/redirect/.test(message) && /allowed|url|whitelist/.test(message)) {
    return { status:503, code:'auth_redirect_misconfigured', category:'redirect_configuration', message:'Account email links are not configured correctly. Please contact the site owner.' };
  }
  if (/database|saving new user|trigger|constraint/.test(message)) {
    return { status:503, code:'signup_database_error', category:'database_or_trigger', message:'The account service could not create your account. Please contact the site owner.' };
  }
  if (/sending confirmation|confirmation email|smtp|email delivery/.test(message)) {
    return { status:503, code:'signup_email_delivery_failed', category:'email_delivery', message:'The confirmation email could not be sent. Please try again later or contact the site owner.' };
  }
  if (/weak_password|password.*(weak|characters|length)/.test(providerCode + ' ' + message)) {
    return { status:400, code:'invalid_password', category:'password_policy', message:'Choose a stronger password that meets the account password requirements.' };
  }
  if (/email_address_invalid|email.*invalid/.test(providerCode + ' ' + message)) {
    return { status:400, code:'invalid_email', category:'invalid_email', message:'Enter a valid email address.' };
  }
  if (/already registered|already been registered|user already exists/.test(message)) {
    return { status:409, code:'email_already_registered', category:'duplicate_account', message:'An account may already exist for this email. Try signing in or resetting your password.' };
  }
  return { status:502, code:'signup_failed', category:'provider_rejected_signup', message:'Your account could not be created. Please try again later.' };
}

function safeAuthDiagnostic(error, category) {
  const code = String(error?.code || '');
  console.error('Supabase signup failed:', {
    category,
    status: Number.isInteger(error?.status) ? error.status : null,
    code: /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : null,
    errorType: /^[A-Za-z0-9_$]{1,64}$/.test(error?.name || '') ? error.name : null
  });
}

function aiFailure(err) {
  const message = String((err && err.message) || '');
  if (err && err.code === 'missing_api_key') {
    return { status: 503, code: 'missing_api_key', message: 'AI is not configured. Add GEMINI_API_KEY to the server environment, then redeploy.' };
  }
  if (err && err.code === 'invalid_api_key') {
    return { status: 401, code: 'invalid_api_key', message: 'Gemini rejected the credential. Set GEMINI_API_KEY to an API key from Google AI Studio, not an OAuth access token, then restart or redeploy.' };
  }
  if (err && err.code === 'invalid_model') {
    return { status: 400, code: 'invalid_model', message: 'The configured Gemini model is unavailable. Check GEMINI_MODEL and GEMINI_FALLBACK_MODEL.' };
  }
  if (err && err.code === 'credits_exhausted' || /quota|credit balance|purchase credits|plans?\s*&?\s*billing/i.test(message)) {
    return { status: 402, code: 'credits_exhausted', message: 'Gemini quota or credit is exhausted. Check Google AI Studio billing and quota.' };
  }
  if ((err && err.code === 'provider_overloaded') || (err && err.status === 503) || /overload|high demand/i.test(message)) {
    return { status: 503, code: 'provider_overloaded', message: 'Gemini is experiencing high demand. Please retry in a moment.' };
  }
  if (err && err.code === 'provider_unavailable') {
    return { status: 503, code: 'provider_unavailable', message: 'Gemini is currently unavailable. Try again later.' };
  }
  if (/overloaded_error|overloaded/i.test(message)) {
    return { status: 529, code: 'provider_overloaded', message: 'The AI provider is temporarily overloaded. Please retry in a moment.' };
  }
  return { status: 502, code: 'upstream_error', message: message || 'The AI provider could not complete the request. Please try again.' };
}

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch(err => {
    const code = String(err?.code || '');
    console.error('Request failed:', {
      route: req.path,
      status: Number.isInteger(err?.status) ? err.status : null,
      code: /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : null,
      errorType: /^[A-Za-z0-9_$]{1,64}$/.test(err?.name || '') ? err.name : null
    });
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

// New Sanitization Helper
function sanitizeUrl(url) {
  if (!url) return '';
  return String(url)
    .trim()
    .replace(/[>\s]+$/, '') // Remove trailing > or whitespace
    .replace(/["']/g, '');   // Remove quotes
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

async function youtubeApiRequest(resource, params) {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + resource);
  Object.entries({ ...params, key: process.env.YOUTUBE_API_KEY }).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'The YouTube Data API request failed.');
  return data;
}

function durationSeconds(isoDuration) {
  const match = String(isoDuration || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return '';
  return (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0);
}

async function getPlaylistItemsFromApi(url) {
  if (!process.env.YOUTUBE_API_KEY) throw new Error('Automated playlist fetching requires YOUTUBE_API_KEY. Paste the lesson titles directly if no key is configured.');
  let playlistId;
  try { playlistId = new URL(url).searchParams.get('list'); } catch (e) {}
  if (!playlistId) throw new Error('That URL does not contain a YouTube playlist ID.');

  const items = [];
  let pageToken = '';
  let pages = 0;
  do {
    const page = await youtubeApiRequest('playlistItems', {
      part: 'snippet,contentDetails', maxResults: '50', playlistId,
      ...(pageToken ? { pageToken } : {})
    });
    for (const entry of page.items || []) {
      const videoId = entry.contentDetails?.videoId || entry.snippet?.resourceId?.videoId;
      const title = entry.snippet?.title;
      if (!videoId || !title || title === 'Private video' || title === 'Deleted video') continue;
      items.push({ index: Number(entry.snippet.position) + 1 || items.length + 1, title, id: videoId, duration: '', url: 'https://www.youtube.com/watch?v=' + videoId });
    }
    pageToken = page.nextPageToken || '';
    pages++;
  } while (pageToken && pages < 20);

  if (!items.length) throw new Error('No videos were found in that playlist.');
  for (let offset = 0; offset < items.length; offset += 50) {
    const batch = items.slice(offset, offset + 50);
    const details = await youtubeApiRequest('videos', {
      part: 'contentDetails', id: batch.map(item => item.id).join(',')
    });
    const durations = new Map((details.items || []).map(video => [video.id, durationSeconds(video.contentDetails?.duration)]));
    batch.forEach(item => { item.duration = durations.get(item.id) ?? ''; });
  }
  return items;
}

function getPlaylistItems(url) {
  const cleanUrl = sanitizeUrl(url);
  return new Promise((resolve, reject) => {
    if (!YT_DLP_PATH) {
      if (process.env.YOUTUBE_API_KEY) return resolve(getPlaylistItemsFromApi(cleanUrl));
      return reject(new Error('Automated playlist fetching requires yt-dlp. On the web version, please paste your playlist video titles directly into the box.'));
    }
    execFile(YT_DLP_PATH, ['--flat-playlist', '--print', '%(playlist_index)s|%(title)s|%(id)s|%(duration)s|%(url)s', cleanUrl], { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
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

app.get(['/api/health', '/health', '/api'], asyncRoute(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const provider = await checkProviderStatus();
  res.json({ ...getHealth(), ...provider, ok: true, service: 'available', ready: provider.ready === true });
}));

app.get('/api/auth/config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ configured: hasSupabaseConfig(), siteUrl: process.env.AUTH_SITE_URL || req.get('origin') || '' });
});

app.post('/api/auth/signup', asyncRoute(async (req, res) => {
  if (!hasSupabaseConfig()) return bad(res, 503, 'Authentication is not configured.', 'auth_unavailable');
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const displayName = String(req.body?.displayName || '').trim().slice(0, 100);
  if (!/^\S+@\S+\.\S+$/.test(email)) return bad(res, 400, 'Enter a valid email address.', 'invalid_email');
  if (password.length < 10 || password.length > 128) return bad(res, 400, 'Use a password between 10 and 128 characters.', 'invalid_password');
  const { url, anonKey } = getSupabaseConfig();
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  let result;
  try {
    result = await client.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName }, emailRedirectTo: (process.env.AUTH_SITE_URL || req.get('origin') || '').replace(/\/$/, '') + '/?auth=verify' }
    });
  } catch (error) {
    const failure = classifySignupFailure(error);
    safeAuthDiagnostic(error, failure.category);
    return bad(res, failure.status, failure.message, failure.code);
  }
  const { data, error } = result;
  if (error) {
    const failure = classifySignupFailure(error);
    safeAuthDiagnostic(error, failure.category);
    return bad(res, failure.status, failure.message, failure.code);
  }
  if (data.session) res.setHeader('Set-Cookie', sessionCookies(data.session));
  res.status(201).json({ user: data.user ? { id: data.user.id, email: data.user.email } : null, confirmationRequired: !data.session });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  if (!hasSupabaseConfig()) return bad(res, 503, 'Authentication is not configured.', 'auth_unavailable');
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return bad(res, 400, 'Email and password are required.', 'missing_credentials');
  const { url, anonKey } = getSupabaseConfig();
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) return bad(res, 401, 'Email or password is incorrect.', 'invalid_credentials');
  res.setHeader('Set-Cookie', sessionCookies(data.session));
  res.json({ user: { id: data.user.id, email: data.user.email } });
}));

app.get('/api/auth/session', authenticateRequest, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

app.post('/api/auth/logout', authenticateRequest, asyncRoute(async (req, res) => {
  const cookies = cookieValues(req);
  try {
    if (cookies.ap_refresh && cookies.ap_access) {
      const { url, anonKey } = getSupabaseConfig();
      const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      await client.auth.setSession({ access_token: cookies.ap_access, refresh_token: cookies.ap_refresh });
      await client.auth.signOut({ scope: 'local' });
    }
  } finally {
    res.setHeader('Set-Cookie', sessionCookies(null, true));
  }
  res.json({ ok: true });
}));

app.post('/api/auth/forgot-password', asyncRoute(async (req, res) => {
  if (!hasSupabaseConfig()) return bad(res, 503, 'Authentication is not configured.', 'auth_unavailable');
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return bad(res, 400, 'Enter a valid email address.', 'invalid_email');
  const { url, anonKey } = getSupabaseConfig();
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const redirectTo = (process.env.AUTH_SITE_URL || req.get('origin') || '').replace(/\/$/, '') + '/?auth=reset';
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) return bad(res, 502, 'Could not send a reset email. Check Supabase Auth email settings.', 'reset_email_failed');
  res.json({ ok: true });
}));

app.post('/api/auth/verify', asyncRoute(async (req, res) => {
  if (!hasSupabaseConfig()) return bad(res, 503, 'Authentication is not configured.', 'auth_unavailable');
  const tokenHash = String(req.body?.token_hash || '').trim();
  const type = String(req.body?.type || 'signup');
  if (!tokenHash || tokenHash.length > 4096 || !['signup','email','recovery','invite','magiclink','email_change'].includes(type)) return bad(res, 400, 'The confirmation link is invalid or expired.', 'invalid_confirmation');
  const { url, anonKey } = getSupabaseConfig();
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error || !data.session) return bad(res, 400, 'The confirmation link is invalid or expired.', 'invalid_confirmation');
  res.setHeader('Set-Cookie', sessionCookies(data.session));
  res.json({ user: { id: data.user.id, email: data.user.email } });
}));

app.post('/api/auth/reset/exchange', asyncRoute(async (req, res) => {
  if (!hasSupabaseConfig()) return bad(res, 503, 'Authentication is not configured.', 'auth_unavailable');
  const code = String(req.body?.code || '').trim();
  if (!code || code.length > 4096) return bad(res, 400, 'The reset link is invalid or expired.', 'invalid_reset_code');
  const { url, anonKey } = getSupabaseConfig();
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  if (error || !data.session) return bad(res, 400, 'The reset link is invalid or expired.', 'invalid_reset_code');
  res.setHeader('Set-Cookie', sessionCookies(data.session));
  res.json({ user: { id: data.user.id, email: data.user.email } });
}));

app.post('/api/auth/reset-password', authenticateRequest, asyncRoute(async (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < 10 || password.length > 128) return bad(res, 400, 'Use a password between 10 and 128 characters.', 'invalid_password');
  const { error } = await req.userSupabase.auth.updateUser({ password });
  if (error) return bad(res, 400, 'Could not update the password. Request a new reset link.', 'password_reset_failed');
  res.json({ ok: true });
}));

app.get('/api/learner/snapshot', authenticateRequest, asyncRoute(async (req, res) => {
  const { data, error } = await req.userSupabase.from('learner_snapshots').select('payload,updated_at').eq('user_id', req.user.id).maybeSingle();
  if (error) return bad(res, 503, 'Could not load your learning data. Apply the database migration and retry.', 'database_unavailable');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ user: { id: req.user.id, email: req.user.email }, snapshot: data?.payload || null, updatedAt: data?.updated_at || null });
}));

app.put('/api/learner/snapshot', authenticateRequest, asyncRoute(async (req, res) => {
  const payload = req.body?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return bad(res, 400, 'A learning snapshot object is required.', 'invalid_snapshot');
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 3 * 1024 * 1024) return bad(res, 413, 'The learning snapshot is too large to save.', 'snapshot_too_large');
  const result = await req.userSupabase.from('learner_snapshots').upsert({ user_id: req.user.id, payload, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }).select('updated_at').single();
  if (result.error) return bad(res, 503, 'Could not save your learning data. Check that the database migration has been applied.', 'database_unavailable');
  res.json({ ok: true, updatedAt: result.data.updated_at });
}));

app.get('/api/learner/export', authenticateRequest, asyncRoute(async (req, res) => {
  const result = await req.userSupabase.from('learner_snapshots').select('payload,updated_at').eq('user_id', req.user.id).maybeSingle();
  if (result.error) return bad(res, 503, 'Could not export your learning data. Apply the database migration and retry.', 'database_unavailable');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', 'attachment; filename="adaptpractice-export.json"');
  res.json({ exportedAt: new Date().toISOString(), userId: req.user.id, snapshot: result.data?.payload || null });
}));

app.delete('/api/learner/snapshot', authenticateRequest, asyncRoute(async (req, res) => {
  for (const table of ['learner_snapshots','student_profiles','learning_events','courses']) {
    const { error } = await req.userSupabase.from(table).delete().eq('user_id', req.user.id);
    if (error) return bad(res, 503, 'Could not completely delete your learning data. Retry after checking the database migration.', 'database_unavailable');
  }
  res.json({ ok: true });
}));

app.get(['/api/playlist', '/playlist'], authenticateRequest, asyncRoute(async (req, res) => {
  const url = sanitizeUrl(req.query.url);
  if (!url) return bad(res, 400, 'A YouTube playlist URL is required.');
  const items = await getPlaylistItems(url);
  res.json({ ok: true, items });
}));

app.post(['/api/ai/text', '/ai/text'], authenticateRequest, persistentUserAiRateLimit, userAiRateLimit, asyncRoute(async (req, res) => {
  const prompt = readPrompt(req, res); if (prompt === null) return;
  const text = await askText(prompt, 1500);
  res.json({ text });
}));

app.post(['/api/ai/json', '/ai/json'], authenticateRequest, persistentUserAiRateLimit, userAiRateLimit, asyncRoute(async (req, res) => {
  const prompt = readPrompt(req, res); if (prompt === null) return;
  const out = await askJSON(prompt, 3500);
  res.json(out);
}));

app.post(['/api/ai/stream', '/ai/stream'], authenticateRequest, persistentUserAiRateLimit, userAiRateLimit, (req, res) => {
  const prompt = readPrompt(req, res); if (prompt === null) return;
  const controller = new AbortController();
  req.on('aborted', () => controller.abort());

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
        console.error('stream error:', err.code || 'provider_error');
        const failure = aiFailure(err);
        finish(`data: ${JSON.stringify({ error: failure.message, code: failure.code })}\n\n`);
      },
      signal: controller.signal
    });
  } catch (err) {
    console.error(err);
    const failure = aiFailure(err);
    finish(`data: ${JSON.stringify({ error: failure.message, code: failure.code })}\n\n`);
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
