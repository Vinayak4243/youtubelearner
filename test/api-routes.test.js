const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { getSupabaseConfig } = require('../server/auth');

process.env.GEMINI_API_KEY = 'test-server-key';
process.env.GEMINI_MODEL = 'test-model';
process.env.YOUTUBE_API_KEY = 'test-youtube-key';
process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
const nativeFetch = global.fetch;
let providerStatus = { status: 200, body: '{}' };
let providerStreamBody = 'data: {"candidates":[{"content":{"parts":[{"text":"streamed answer"}]}}]}\n\n';
let lastSnapshotWrite = null;
let youtubePageRequests = [];
let youtubePlaylistStatus = 200;
const testAccessToken = [
  Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
  Buffer.from(JSON.stringify({ sub:'user-1', exp:Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'),
  ''
].join('.');
let signupResponse = {
  status:200,
  body:{
    id:'new-user',
    aud:'authenticated',
    role:'authenticated',
    email:'new-learner@example.test',
    app_metadata:{ provider:'email', providers:['email'] },
    user_metadata:{ display_name:'New Learner' },
    identities:[{ identity_id:'new-identity', id:'new-learner@example.test', user_id:'new-user', identity_data:{ email:'new-learner@example.test' }, provider:'email' }],
    created_at:'2026-10-02T00:00:00Z',
    updated_at:'2026-10-02T00:00:00Z'
  }
};
global.fetch = async (input, init) => {
  const url = new URL(input);
  if (url.hostname === 'www.googleapis.com') {
    assert.equal(url.searchParams.get('key'), process.env.YOUTUBE_API_KEY);
    assert.equal(new Headers(init.headers).has('referer'), false);
    if (youtubePlaylistStatus !== 200) {
      return new Response(JSON.stringify({ error:{ message:'Requests from referer <empty> are blocked.' } }), {
        status:youtubePlaylistStatus, headers:{ 'content-type':'application/json' }
      });
    }
    if (url.pathname.endsWith('/playlistItems')) {
      const token = url.searchParams.get('pageToken') || '';
      youtubePageRequests.push(token);
      const page = token ? Number(token.replace('next-','')) : 1;
      const videoId = 'v' + String(page).padStart(10, '0');
      return new Response(JSON.stringify({
        items:[
          { snippet:{ position:page-1, title:`Actual video ${page}`, resourceId:{ videoId } }, contentDetails:{ videoId } },
          { snippet:{ position:page, title:'YouTube navigation text', resourceId:{ videoId:'invalid' } }, contentDetails:{ videoId:'invalid' } }
        ],
        ...(page < 22 ? { nextPageToken:'next-' + (page+1) } : {})
      }), { status:200, headers:{ 'content-type':'application/json' } });
    }
    if (url.pathname.endsWith('/videos')) {
      return new Response(JSON.stringify({ items:[{ id:url.searchParams.get('id'), snippet:{ title:'Metadata title' } }] }), {
        status:200, headers:{ 'content-type':'application/json' }
      });
    }
    throw new Error(`Unexpected YouTube API request: ${url.pathname}`);
  }
  if (url.hostname === 'supabase.test') {
    if (url.pathname.endsWith('/auth/v1/signup')) {
      assert.equal(new Headers(init.headers).get('apikey'), process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY);
      return new Response(JSON.stringify(signupResponse.body), { status:signupResponse.status, headers:{'content-type':'application/json'} });
    }
    if (url.pathname.endsWith('/auth/v1/token')) {
      return new Response(JSON.stringify({
        access_token:testAccessToken,
        refresh_token:'test-refresh-token',
        expires_in:3600,
        token_type:'bearer',
        user:{ id:'user-1', email:'learner@example.test' }
      }), { status:200, headers:{'content-type':'application/json'} });
    }
    if (url.pathname.endsWith('/auth/v1/recover') || url.pathname.endsWith('/auth/v1/logout')) {
      return new Response('{}', { status:200, headers:{'content-type':'application/json'} });
    }
    if (url.pathname.endsWith('/rest/v1/rpc/consume_user_ai_rate_limit')) return new Response('true', { status:200, headers:{'content-type':'application/json'} });
    if (url.pathname.endsWith('/auth/v1/user')) {
      if (init.method && init.method !== 'GET') {
        return new Response(JSON.stringify({ id:'user-1', email:'learner@example.test' }), { status:200, headers:{'content-type':'application/json'} });
      }
      if (new Headers(init.headers).get('authorization') === `Bearer ${testAccessToken}`) {
        return new Response(JSON.stringify({ id:'user-1', email:'learner@example.test' }), { status:200 });
      }
      if (new Headers(init.headers).get('authorization') === 'Bearer test-token') {
        return new Response(JSON.stringify({ id: 'user-1', email: 'learner@example.test' }), { status: 200 });
      }
      if (new Headers(init.headers).get('authorization') !== 'Bearer valid-user-token') {
        return new Response(JSON.stringify({ message: 'invalid token' }), { status: 401 });
      }
      return new Response(JSON.stringify({ id: 'user-1', email: 'learner@example.test' }), { status: 200 });
    }
    if (url.pathname.endsWith('/rest/v1/learner_snapshots')) {
      if (init.method === 'POST') {
        lastSnapshotWrite = JSON.parse(init.body);
        return new Response(JSON.stringify([{ updated_at: '2026-10-02T00:00:00Z' }]), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ payload: { profile: { name: 'Learner' }, courses: [] }, updated_at: '2026-10-02T00:00:00Z' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected Supabase request: ${url.pathname}`);
  }
  if (url.hostname !== 'generativelanguage.googleapis.com') return nativeFetch(input, init);
  if (url.pathname.endsWith(':countTokens')) {
    return new Response(providerStatus.body, { status: providerStatus.status });
  }
  const payload = JSON.parse(init.body);
  assert.equal(payload.contents[0].parts[0].text.includes('test prompt'), true);
  assert.equal(new URL(url).searchParams.has('key'), false);
  assert.equal(new Headers(init.headers).get('x-goog-api-key'), 'test-server-key');
  if (url.pathname.endsWith(':streamGenerateContent')) {
    return new Response(providerStreamBody, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
};

const app = require('../api/ai/json');
let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('health distinguishes an available service from a verified ready provider', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type').includes('application/json'), true);
  const body = await response.json();
  assert.equal(body.service, 'available');
  assert.equal(body.ready, true);
  assert.equal(body.model, 'test-model');
});

test('provider credential failures do not make the API service unavailable', async () => {
  providerStatus = { status: 403, body: JSON.stringify({ error: { code: 403, message: 'invalid API key' } }) };
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();
  providerStatus = { status: 200, body: '{}' };
  assert.equal(response.status, 200);
  assert.equal(body.service, 'available');
  assert.equal(body.ready, false);
  assert.equal(body.code, 'invalid_api_key');
});

test('AI provider credentials come only from the server environment', async () => {
  const response = await fetch(`${baseUrl}/api/ai/json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer valid-user-token', 'x-api-key': 'client-supplied-key' },
    body: JSON.stringify({ prompt: 'test prompt' })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('AI streaming returns provider deltas before the response completes', async () => {
  const response = await fetch(`${baseUrl}/api/ai/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify({ prompt: 'test prompt' })
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /"delta":"streamed answer"/);
  assert.match(body, /data: \[DONE\]/);
});

test('playlist API rejects non-YouTube URLs before fetching metadata', async () => {
  const url = encodeURIComponent('https://example.com/playlist?list=PL1234567890');
  const response = await fetch(`${baseUrl}/api/playlist?url=${url}`, {
    headers: { authorization: 'Bearer test-token' }
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.code, 'invalid_youtube_url');
});

test('playlist import reads every YouTube API page and returns only valid playlist video records', async () => {
  youtubePageRequests = [];
  const playlistId = 'PLhR2IpV1b2FwWwviBHRrR118YAaSlyhTU';
  const response = await fetch(`${baseUrl}/api/playlist?url=${encodeURIComponent(`https://www.youtube.com/playlist?list=${playlistId}`)}`, {
    headers: { cookie:`ap_access=${encodeURIComponent(testAccessToken)}` }
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.items.length, 22);
  assert.equal(body.unavailableCount, 22);
  assert.equal(youtubePageRequests.length, 22);
  assert.deepEqual(body.items.slice(0, 2).map(item => [item.index, item.title]), [
    [1, 'Actual video 1'], [2, 'Actual video 2']
  ]);
  assert.equal(body.items[21].id, 'v0000000022');
  assert.equal(body.items[21].url, 'https://www.youtube.com/watch?v=v0000000022');
  assert.equal(body.items.some(item => item.title.includes('navigation')), false);
});

test('playlist import reports referrer restrictions without spoofing request headers', async () => {
  youtubePlaylistStatus = 403;
  const response = await fetch(`${baseUrl}/api/playlist?url=${encodeURIComponent('https://www.youtube.com/playlist?list=PLhR2IpV1b2FwWwviBHRrR118YAaSlyhTU')}`, {
    headers: { cookie:`ap_access=${encodeURIComponent(testAccessToken)}` }
  });
  const body = await response.json();
  youtubePlaylistStatus = 200;
  assert.equal(response.status, 403);
  assert.equal(body.code, 'youtube_api_key_restricted');
  assert.match(body.error, /application restriction to None/);
});

test('video metadata route returns metadata separately from transcript availability', async () => {
  const response = await fetch(`${baseUrl}/api/video?url=${encodeURIComponent('https://youtu.be/YvvAnuOzOSY')}`, {
    headers: { cookie:`ap_access=${encodeURIComponent(testAccessToken)}` }
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.video, { id:'YvvAnuOzOSY', title:'Metadata title' });
  assert.equal(body.transcriptAvailable, false);
});

test('browser loads source parsing helpers before application code', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.indexOf('src="source-context.js"') < html.indexOf('src="app.js"'));
});

test('Vercel has explicit function entry points for nested AI endpoints', () => {
  for (const name of ['json', 'text', 'stream']) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'api', 'ai', `${name}.js`)), true);
  }
  for (const name of ['auth', 'learner']) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'api', name, '[...path].js')), true);
  }
});

for (const name of ['json', 'text', 'stream']) {
  test(`POST /api/ai/${name} is routed and validates its prompt`, async () => {
    const response = await fetch(`${baseUrl}/api/ai/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer valid-user-token' },
      body: '{}'
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.match(body.error, /prompt is required/);
  });
}

test('AI routes deny unauthenticated users', async () => {
  const response = await fetch(`${baseUrl}/api/ai/json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'test prompt' })
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'not_authenticated');
});

test('Auth config reports availability without returning the anon key', async () => {
  const response = await fetch(`${baseUrl}/api/auth/config`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.configured, true);
  assert.equal(Object.hasOwn(body, 'anonKey'), false);
});

test('Auth config accepts the Supabase publishable key without exposing it', async () => {
  const originalAnonKey = process.env.SUPABASE_ANON_KEY;
  const originalPublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_ANON_KEY = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key';

  try {
    const response = await fetch(`${baseUrl}/api/auth/config`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.configured, true);
    assert.equal(Object.hasOwn(body, 'anonKey'), false);
    assert.equal(Object.hasOwn(body, 'publishableKey'), false);
  } finally {
    if (originalAnonKey === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = originalAnonKey;
    if (originalPublishableKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = originalPublishableKey;
  }
});

test('signup with confirmation required returns success without creating a session cookie', async () => {
  const originalPublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key';
  try {
    const response = await fetch(`${baseUrl}/api/auth/signup`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ email:'new-learner@example.test', password:'valid-test-password', displayName:'New Learner' })
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.confirmationRequired, true);
    assert.equal(body.user.email, 'new-learner@example.test');
    assert.equal(response.headers.get('set-cookie'), null);
  } finally {
    if (originalPublishableKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = originalPublishableKey;
  }
});

test('mocked authentication supports sign-in, sign-out, recovery email and password update', async () => {
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ email:'learner@example.test', password:'valid-test-password' })
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.id, 'user-1');
  assert.match(login.headers.get('set-cookie') || '', /ap_access=.*HttpOnly/);

  const recovery = await fetch(`${baseUrl}/api/auth/forgot-password`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ email:'learner@example.test' })
  });
  assert.equal(recovery.status, 200);

  const passwordUpdate = await fetch(`${baseUrl}/api/auth/reset-password`, {
    method:'POST',
    headers:{ 'content-type':'application/json', authorization:`Bearer ${testAccessToken}`, cookie:`ap_access=${testAccessToken}; ap_refresh=test-refresh-token` },
    body:JSON.stringify({ password:'updated-test-password' })
  });
  assert.equal(passwordUpdate.status, 200, await passwordUpdate.clone().text());

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method:'POST',
    headers:{ 'content-type':'application/json', authorization:`Bearer ${testAccessToken}`, cookie:`ap_access=${testAccessToken}; ap_refresh=test-refresh-token` },
    body:'{}'
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/);
});

test('signup database failures return a sanitized error and log only safe diagnostics', async () => {
  const previousResponse = signupResponse;
  const previousConsoleError = console.error;
  const diagnosticLines = [];
  signupResponse = {
    status:500,
    body:{ code:'unexpected_failure', msg:'Database error saving new user' }
  };
  console.error = (...args) => diagnosticLines.push(args);

  try {
    const response = await fetch(`${baseUrl}/api/auth/signup`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ email:'private-learner@example.test', password:'private-test-password', displayName:'Private Learner' })
    });
    const body = await response.json();
    const diagnostics = JSON.stringify(diagnosticLines);
    assert.equal(response.status, 503);
    assert.equal(body.code, 'signup_database_error');
    assert.doesNotMatch(body.error, /database error saving new user/i);
    assert.doesNotMatch(diagnostics, /private-learner|private-test-password/i);
    assert.match(diagnostics, /database_or_trigger/);
    assert.match(diagnostics, /"status":500/);
    assert.doesNotMatch(diagnostics, /database error saving new user/i);
  } finally {
    signupResponse = previousResponse;
    console.error = previousConsoleError;
  }
});

test('Vercel catch-all API paths route auth and learner requests to Express endpoints', async () => {
  const originalVercel = process.env.VERCEL;
  process.env.VERCEL = '1';
  try {
    const configResponse = await fetch(`${baseUrl}/auth/config`);
    assert.equal(configResponse.status, 200);
    assert.equal((await configResponse.json()).configured, true);

    const sessionResponse = await fetch(`${baseUrl}/learner/snapshot`);
    assert.equal(sessionResponse.status, 401);
    assert.equal((await sessionResponse.json()).code, 'not_authenticated');
  } finally {
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  }
});

test('Supabase REST endpoint URLs are normalized to the project URL', () => {
  const originalUrl = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = 'https://supabase.test/rest/v1/';
  try {
    assert.equal(getSupabaseConfig().url, 'https://supabase.test');
  } finally {
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
  }
});

test('an anonymous auth session request reports no session rather than a login failure', async () => {
  const response = await fetch(`${baseUrl}/api/auth/session`);
  const body = await response.json();
  assert.equal(response.status, 401);
  assert.equal(body.code, 'not_authenticated');
});

test('snapshot reads require an authenticated user', async () => {
  const response = await fetch(`${baseUrl}/api/learner/snapshot`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'not_authenticated');
});

test('authenticated users read only the RLS-scoped snapshot client', async () => {
  const response = await fetch(`${baseUrl}/api/learner/snapshot`, { headers: { authorization: 'Bearer valid-user-token' } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.user.id, 'user-1');
  assert.deepEqual(body.snapshot.profile, { name: 'Learner' });
});

test('snapshot ownership is assigned from the verified user, not request data', async () => {
  const response = await fetch(`${baseUrl}/api/learner/snapshot`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer valid-user-token' },
    body: JSON.stringify({ user_id: 'attacker-user', payload: { profile: { name: 'Learner' }, courses: [] } })
  });
  assert.equal(response.status, 200);
  assert.equal(lastSnapshotWrite.user_id, 'user-1');
  assert.equal(lastSnapshotWrite.payload.profile.name, 'Learner');
});

test.after(() => { global.fetch = nativeFetch; });
