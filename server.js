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
const {
  normalizePlaylistUrl: normalizeYouTubePlaylistUrl,
  videoId: parseYouTubeVideoId
} = require('./public/youtube-url');

const { askText, askJSON, streamText, MODEL, getHealth, checkProviderStatus } = require('./ai');
const { createSummary } = require('./services/summary-pipeline');

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
      if (isMissingSupabaseRpc(error)) {
        console.warn('consume_user_ai_rate_limit is missing; using the per-instance AI rate limiter until the migration is applied.');
        res.setHeader('X-AdaptPractice-Rate-Limit-Mode', 'instance-fallback');
        return next();
      }
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

function isMissingSupabaseRpc(error) {
  return ['PGRST202', '42883'].includes(String(error?.code || ''));
}

function isMissingSnapshotStorage(error) {
  return ['PGRST202', 'PGRST205', '42P01', '42883'].includes(String(error?.code || ''));
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
  const provider = err?.provider === 'openai' ? 'OpenAI' : 'Gemini';
  if (err && err.code === 'missing_api_key') {
    return { status: 503, code: 'missing_api_key', message: 'AI is not configured. Add a supported provider API key to the server environment, then redeploy.' };
  }
  if (err && err.code === 'invalid_api_key') {
    return { status: 401, code: 'invalid_api_key', message: `${provider} rejected its configured credential. Check the provider API key in the server environment.` };
  }
  if (err && err.code === 'invalid_model') {
    return { status: 400, code: 'invalid_model', message: `No available ${provider} model passed the provider check. Verify the server model setting and API-key access.` };
  }
  if (err && err.code === 'credits_exhausted' || /quota|credit balance|purchase credits|plans?\s*&?\s*billing/i.test(message)) {
    return { status: 402, code: 'credits_exhausted', message: `${provider} quota or credits are exhausted. Check the provider's billing and quota settings.` };
  }
  if ((err && err.code === 'provider_overloaded') || (err && err.status === 503) || /overload|high demand/i.test(message)) {
    return { status: 503, code: 'provider_overloaded', message: `${provider} is temporarily overloaded. Please retry in a moment.` };
  }
  if (err && err.code === 'provider_unavailable') {
    return { status: 503, code: 'provider_unavailable', message: `${provider} is currently unavailable. Try again later.` };
  }
  if (err && err.code === 'provider_timeout') {
    return { status: 504, code: 'provider_timeout', message: `The ${provider} request timed out. Please retry.` };
  }
  if (/overloaded_error|overloaded/i.test(message)) {
    return { status: 529, code: 'provider_overloaded', message: `${provider} is temporarily overloaded. Please retry in a moment.` };
  }
  return { status: 502, code: 'upstream_error', message: message ? `${provider} request failed: ${message}` : `${provider} could not complete the request. Please try again.` };
}

function summaryFailure(err) {
  const code = String(err?.code || 'LLM_ERROR');
  const known = {
    AUTH_ERROR:[503, 'The summary service is temporarily unavailable. Please try again later.'],
    RATE_LIMIT:[429, 'Busy right now. Try again shortly.'],
    TIMEOUT:[504, 'This video is taking longer than expected. Try summarizing it section by section.'],
    INVALID_MODEL_OUTPUT:[502, "Some sections couldn't be generated. Please retry."],
    TRANSCRIPT_UNAVAILABLE:[422, 'No transcript found. Add transcript text to create a source-grounded summary.'],
    INVALID_URL:[400, "That doesn't look like a YouTube link."],
    LLM_ERROR:[502, 'The summary service could not complete this request. Please retry.']
  }[code] || [502, 'The summary service could not complete this request. Please retry.'];
  return { status:known[0], code, message:known[1] };
}

function readSummaryRequest(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const transcript = body.transcript || body.source_segments;
  const characterCount = typeof transcript === 'string' ? transcript.length : Array.isArray(transcript) ? JSON.stringify(transcript).length : 0;
  if (characterCount > MAX_PROMPT_CHARS) { bad(res, 413, 'The transcript is too large. Send a shorter section.', 'transcript_too_large'); return null; }
  if (typeof transcript !== 'string' && !Array.isArray(transcript)) { bad(res, 400, 'Provide a timestamped transcript.', 'TRANSCRIPT_UNAVAILABLE'); return null; }
  return {
    user_id:req.user.id,
    video_id:typeof body.video_id === 'string' ? body.video_id.slice(0,128) : '',
    video_meta:body.video_meta && typeof body.video_meta === 'object' ? body.video_meta : {},
    transcript,
    transcript_status:typeof body.transcript_status === 'string' ? body.transcript_status : undefined,
    goal:typeof body.goal === 'string' ? body.goal.slice(0,200) : 'learning',
    background_profile:body.background_profile && typeof body.background_profile === 'object' ? body.background_profile : null,
    student_state:body.student_state && typeof body.student_state === 'object' ? body.student_state : null
  };
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
    if (code.startsWith('youtube_')) {
      return bad(res, Number.isInteger(err.status) ? err.status : 502, err.message, code);
    }
    if (/^\/(?:api\/)?ai(?:\/|$)/.test(req.path)) {
      const failure = aiFailure(err);
      return bad(res, failure.status, failure.message, failure.code);
    }
    return bad(res, Number.isInteger(err.status) ? err.status : 500, 'The request could not be completed. Please retry.', 'request_failed');
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

const YOUTUBE_API_TIMEOUT_MS = 45000;

async function youtubeApiRequest(resource, params, signal) {
  if (!process.env.YOUTUBE_API_KEY) {
    const error = new Error('Automated playlist imports need YOUTUBE_API_KEY configured on the server.');
    error.code = 'youtube_api_key_missing';
    error.status = 503;
    throw error;
  }
  const url = new URL('https://www.googleapis.com/youtube/v3/' + resource);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set('key', process.env.YOUTUBE_API_KEY);
  let response;
  try {
    response = await fetch(url, { signal });
  } catch (cause) {
    const error = new Error('The YouTube request timed out or could not connect. Check the server network and retry.');
    error.code = 'youtube_request_timeout';
    error.status = 504;
    error.cause = cause;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reasons = (data.error?.errors || []).map(item => item.reason).filter(Boolean);
    const reason = reasons[0] || '';
    const error = new Error('The YouTube Data API request failed.');
    error.status = response.status;
    if (reason === 'API_KEY_HTTP_REFERRER_BLOCKED' || /referer.*blocked/i.test(data.error?.message || '')) {
      error.code = 'youtube_api_key_restricted';
      error.message = 'The server-side YouTube API key is restricted by an HTTP referrer. Set its application restriction to None (or a fixed server egress IP, if available) and restrict API access to YouTube Data API v3.';
    } else if (reason === 'quotaExceeded') {
      error.code = 'youtube_quota_exceeded';
      error.message = 'The YouTube Data API quota is exhausted. Check Google Cloud Console → APIs & Services → YouTube Data API v3 → Quotas, then retry.';
    } else if (/API key not valid|invalid.*key/i.test(data.error?.message || '')) {
      error.code = 'youtube_api_key_invalid';
      error.message = 'The server-side YouTube Data API key was rejected. Check YOUTUBE_API_KEY in the server environment.';
    } else {
      error.code = 'youtube_api_error';
    }
    throw error;
  }
  return data;
}

async function getPlaylistItemsFromApi(url) {
  if (!process.env.YOUTUBE_API_KEY) throw new Error('Automated playlist fetching requires YOUTUBE_API_KEY. Paste the lesson titles directly if no key is configured.');
  let playlistId;
  try { playlistId = new URL(url).searchParams.get('list'); } catch (e) {}
  if (!playlistId) throw new Error('That URL does not contain a YouTube playlist ID.');

  const items = [];
  let unavailableCount = 0;
  let pageToken = '';
  const timeout = AbortSignal.timeout(YOUTUBE_API_TIMEOUT_MS);
  do {
    const page = await youtubeApiRequest('playlistItems', {
      part: 'snippet,contentDetails', maxResults: '50', playlistId,
      fields: 'nextPageToken,items(snippet(position,title,resourceId/videoId),contentDetails/videoId)',
      ...(pageToken ? { pageToken } : {})
    }, timeout);
    for (const entry of page.items || []) {
      const videoId = entry.contentDetails?.videoId || entry.snippet?.resourceId?.videoId;
      const title = typeof entry.snippet?.title === 'string' ? entry.snippet.title.trim() : '';
      const position = Number(entry.snippet?.position);
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '') || !title || title === 'Private video' || title === 'Deleted video') {
        unavailableCount++;
        continue;
      }
      items.push({
        index: Number.isInteger(position) && position >= 0 ? position + 1 : items.length + 1,
        title,
        id: videoId,
        duration: '',
        url: 'https://www.youtube.com/watch?v=' + videoId
      });
    }
    pageToken = page.nextPageToken || '';
  } while (pageToken);

  if (!items.length) throw new Error('No videos were found in that playlist.');
  return { items, unavailableCount };
}

async function getVideoMetadata(videoId) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) throw new Error('Enter a valid YouTube video link.');
  const signal = AbortSignal.timeout(YOUTUBE_API_TIMEOUT_MS);
  const result = await youtubeApiRequest('videos', {
    part: 'snippet', id: videoId, fields: 'items(id,snippet(title))'
  }, signal);
  const video = (result.items || []).find(item => item.id === videoId);
  if (!video?.snippet?.title) {
    const error = new Error('YouTube did not return public metadata for this video. Check that the video is available.');
    error.code = 'youtube_video_metadata_unavailable';
    error.status = 404;
    throw error;
  }
  return { id:videoId, title:video.snippet.title };
}

function getPlaylistItems(url) {
  const cleanUrl = sanitizeUrl(url);
  if (process.env.YOUTUBE_API_KEY) return getPlaylistItemsFromApi(cleanUrl);
  if (process.env.VERCEL) {
    const error = new Error('Playlist import is not configured. Add YOUTUBE_API_KEY as a server-only Vercel environment variable and redeploy.');
    error.code = 'youtube_api_key_missing';
    error.status = 503;
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    if (!YT_DLP_PATH) {
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
      resolve({ items, unavailableCount:0 });
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
    if (cookies.ap_refresh && req.authToken) {
      const { url, anonKey } = getSupabaseConfig();
      const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      await client.auth.setSession({ access_token: req.authToken, refresh_token: cookies.ap_refresh });
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
  const refreshToken = cookieValues(req).ap_refresh;
  if (!refreshToken) return bad(res, 401, 'Your password reset session has expired. Request a new reset link.', 'session_expired');
  const { data: sessionData, error: sessionError } = await req.userSupabase.auth.setSession({
    access_token: req.authToken,
    refresh_token: refreshToken
  });
  if (sessionError || !sessionData.session) return bad(res, 401, 'Your password reset session has expired. Request a new reset link.', 'session_expired');
  const { error } = await req.userSupabase.auth.updateUser({ password });
  if (error) return bad(res, 400, 'Could not update the password. Request a new reset link.', 'password_reset_failed');
  res.json({ ok: true });
}));

app.get('/api/learner/snapshot', authenticateRequest, asyncRoute(async (req, res) => {
  const { data, error } = await req.userSupabase.rpc('get_learner_snapshot_piece', { p_chunk_index:-1 });
  if (error && isMissingSupabaseRpc(error)) {
    const legacy = await req.userSupabase.from('learner_snapshots')
      .select('payload,updated_at')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (legacy.error) {
      return bad(res, 503, 'Could not load your learning data. Apply the snapshot database migration and retry.', 'database_unavailable');
    }
    const snapshot = legacy.data?.payload || null;
    if (snapshot !== null && (typeof snapshot !== 'object' || Array.isArray(snapshot))) {
      return bad(res, 503, 'The saved learning data is invalid. Contact support before retrying.', 'invalid_saved_snapshot');
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      user:{ id:req.user.id, email:req.user.email },
      snapshot,
      hasSnapshot:Boolean(snapshot),
      chunkCount:snapshot ? 1 : 0,
      revision:0,
      updatedAt:legacy.data?.updated_at || null
    });
  }
  if (error) return bad(res, 503, 'Could not load your learning data. Apply the database migration and retry.', 'database_unavailable');
  const row = Array.isArray(data) ? data[0] : data;
  let snapshot = null;
  try { snapshot = row?.content ? JSON.parse(row.content) : null; }
  catch(error) { return bad(res, 503, 'The saved learning data could not be decoded. Contact support before retrying.', 'invalid_saved_snapshot'); }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    user:{ id:req.user.id, email:req.user.email },
    snapshot,
    hasSnapshot:Number(row?.chunk_count) > 0,
    chunkCount:Number(row?.chunk_count) || 0,
    revision:Number(row?.revision) || 0,
    updatedAt:row?.updated_at || null
  });
}));

app.get('/api/learner/snapshot/chunk', authenticateRequest, asyncRoute(async (req, res) => {
  const index = Number(req.query.index);
  if (!Number.isInteger(index) || index < 0 || index >= 128) return bad(res, 400, 'Snapshot chunk index is invalid.', 'invalid_snapshot_chunk');
  const { data, error } = await req.userSupabase.rpc('get_learner_snapshot_piece', { p_chunk_index:index });
  if (error) return bad(res, 503, 'Could not load your learning data. Apply the large-snapshot migration and retry.', 'database_unavailable');
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.content) return bad(res, 404, 'The requested learning-data chunk is unavailable.', 'snapshot_chunk_not_found');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ index, count:Number(row.chunk_count) || 0, revision:Number(row.revision) || 0, content:row.content });
}));

app.post('/api/learner/snapshot/chunk', authenticateRequest, asyncRoute(async (req, res) => {
  const { uploadId, index, count, content } = req.body || {};
  if (typeof uploadId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(uploadId)
    || !Number.isInteger(index) || !Number.isInteger(count) || count < 1 || count > 128
    || index < 0 || index >= count || typeof content !== 'string' || !content
    || Buffer.byteLength(content, 'utf8') > 1024 * 1024) {
    return bad(res, 400, 'Snapshot chunk is invalid or too large.', 'invalid_snapshot_chunk');
  }
  const { error } = await req.userSupabase.from('learner_snapshot_uploads').upsert({
    user_id:req.user.id, upload_id:uploadId, chunk_index:index, chunk_count:count, content
  }, { onConflict:'user_id,upload_id,chunk_index' });
  if (error && isMissingSnapshotStorage(error)) return bad(res, 503, 'Chunked snapshot storage is not installed.', 'snapshot_migration_missing');
  if (error) return bad(res, 503, 'Could not stage learning data. Apply the large-snapshot migration and retry.', 'database_unavailable');
  res.json({ ok:true, index });
}));

app.post('/api/learner/snapshot/commit', authenticateRequest, asyncRoute(async (req, res) => {
  const { uploadId, count, baseRevision } = req.body || {};
  if (typeof uploadId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(uploadId)
    || !Number.isInteger(count) || count < 1 || count > 128
    || !Number.isInteger(baseRevision) || baseRevision < 0) {
    return bad(res, 400, 'Snapshot commit details are invalid.', 'invalid_snapshot');
  }
  const { data, error } = await req.userSupabase.rpc('commit_learner_snapshot_upload', {
    p_upload_id:uploadId,
    p_expected_revision:baseRevision,
    p_chunk_count:count
  });
  if (error && isMissingSnapshotStorage(error)) return bad(res, 503, 'Chunked snapshot storage is not installed.', 'snapshot_migration_missing');
  if (error) return bad(res, 503, 'Could not commit learning data. Check the large-snapshot migration and retry.', 'database_unavailable');
  if (!data?.ok) return bad(res, 409, 'Learning data changed on another device. Synchronizing both versions.', 'snapshot_conflict');
  res.json({ ok:true, revision:Number(data.revision) });
}));

app.put('/api/learner/snapshot', authenticateRequest, asyncRoute(async (req, res) => {
  const payload = req.body?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return bad(res, 400, 'A learning snapshot object is required.', 'invalid_snapshot');
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 3 * 1024 * 1024) return bad(res, 413, 'This legacy save endpoint accepts up to 3 MB. Use the chunked snapshot uploader.', 'snapshot_too_large');
  const snapshot = { user_id:req.user.id, payload, updated_at:new Date().toISOString() };
  let result;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'expectedUpdatedAt')) {
    if (req.body.expectedUpdatedAt === null) {
      result = await req.userSupabase.from('learner_snapshots').insert(snapshot).select('updated_at').maybeSingle();
      if (result.error && String(result.error.code || '') === '23505') {
        return bad(res, 409, 'Learning data changed on another device. Synchronizing both versions.', 'snapshot_conflict');
      }
    } else if (typeof req.body.expectedUpdatedAt === 'string' && req.body.expectedUpdatedAt) {
      result = await req.userSupabase.from('learner_snapshots').update(snapshot)
        .eq('user_id', req.user.id)
        .eq('updated_at', req.body.expectedUpdatedAt)
        .select('updated_at')
        .maybeSingle();
      if (!result.error && !result.data) {
        return bad(res, 409, 'Learning data changed on another device. Synchronizing both versions.', 'snapshot_conflict');
      }
    } else {
      return bad(res, 400, 'The expected snapshot version is invalid.', 'invalid_snapshot');
    }
  } else {
    result = await req.userSupabase.from('learner_snapshots')
      .upsert(snapshot, { onConflict:'user_id' })
      .select('updated_at')
      .single();
  }
  if (result.error) return bad(res, 503, 'Could not save your learning data. Check that the database migration has been applied.', 'database_unavailable');
  res.json({ ok:true, legacy:true, revision:0, updatedAt:result.data?.updated_at || snapshot.updated_at });
}));

app.get('/api/learner/export', authenticateRequest, asyncRoute(async (req, res) => {
  const result = await req.userSupabase.rpc('get_learner_snapshot_chunks');
  if (result.error) return bad(res, 503, 'Could not export your learning data. Apply the database migration and retry.', 'database_unavailable');
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  let snapshot = null;
  try { snapshot = row?.snapshot ? JSON.parse(row.snapshot) : null; }
  catch(error) { return bad(res, 503, 'The saved learning data could not be decoded. Contact support before retrying.', 'invalid_saved_snapshot'); }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', 'attachment; filename="adaptpractice-export.json"');
  res.json({ exportedAt:new Date().toISOString(), userId:req.user.id, snapshot });
}));

app.delete('/api/learner/snapshot', authenticateRequest, asyncRoute(async (req, res) => {
  for (const table of ['learner_snapshot_uploads','learner_snapshot_chunks','learner_snapshot_heads','learner_snapshots','student_profiles','learning_events','courses']) {
    const { error } = await req.userSupabase.from(table).delete().eq('user_id', req.user.id);
    if (error) return bad(res, 503, 'Could not completely delete your learning data. Retry after checking the database migration.', 'database_unavailable');
  }
  res.json({ ok: true });
}));

app.get(['/api/playlist', '/playlist'], authenticateRequest, asyncRoute(async (req, res) => {
  const url = normalizeYouTubePlaylistUrl(req.query.url);
  if (!url) return bad(res, 400, 'Enter a valid YouTube playlist URL with a playlist ID.', 'invalid_youtube_url');
  const result = await getPlaylistItems(url);
  res.json({ ok: true, ...result });
}));

app.get('/api/video', authenticateRequest, asyncRoute(async (req, res) => {
  const videoId = parseYouTubeVideoId(req.query.url);
  if (!videoId) return bad(res, 400, 'Enter a valid YouTube video link.', 'invalid_youtube_url');
  const video = await getVideoMetadata(videoId);
  res.json({ ok:true, video, transcriptAvailable:false });
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

app.post(['/api/summary', '/summary'], authenticateRequest, persistentUserAiRateLimit, userAiRateLimit, asyncRoute(async (req, res) => {
  const input = readSummaryRequest(req, res); if (!input) return;
  try {
    const result = await createSummary(input);
    // answerKey remains server-side; it can later be fetched only after a learner submits answers.
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok:true, summary:result.summary, meta:result.meta });
  } catch (error) {
    const failure = summaryFailure(error);
    console.error('Summary request failed:', { code:failure.code, userId:req.user.id });
    bad(res, failure.status, failure.message, failure.code);
  }
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
  res.on('close', () => {
    if (!res.writableEnded) {
      done = true;
      controller.abort();
    }
  });

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

app.use('/api', (req, res) => bad(res, 404, 'API endpoint not found.', 'not_found'));
app.use((error, req, res, next) => {
  if (!req.path.startsWith('/api/')) return next(error);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 400;
  return bad(res, status, status === 400 ? 'The API request was invalid.' : 'The API request could not be completed.', 'invalid_api_request');
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AdaptPractice running: http://localhost:${PORT}`);
    console.log(`Health: ${JSON.stringify(getHealth())}`);
    if (!ALLOWED.length) console.log('ALLOWED_ORIGINS is empty — every origin is currently allowed.');
  });
}

module.exports = app;
