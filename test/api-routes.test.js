const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { getSupabaseConfig, sessionCookies } = require('../server/auth');

process.env.GEMINI_API_KEY = 'test-server-key';
process.env.GEMINI_MODEL = 'retired-configured-model';
process.env.YOUTUBE_API_KEY = 'test-youtube-key';
process.env.OPENAI_API_KEY = '';
process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
const nativeFetch = global.fetch;
let providerStatus = { status: 200, body: '{}' };
let providerStreamBody = 'data: {"candidates":[{"content":{"parts":[{"text":"streamed answer"}]}}]}\n\n';
let lastSnapshotWrite = null;
let mockSnapshotRevision = 3;
let missingSnapshotRpc = false;
let missingAiRateLimitRpc = false;
let youtubePageRequests = [];
let youtubePlaylistStatus = 200;
let refreshStatus = 200;
let refreshRequestCount = 0;
let signupRedirectTo = '';
let recoveryRedirectTo = '';
let generatedResponseMimeTypes = [];
let generationFailure = null;
const modelProbeFailures = new Set();
const unavailableGenerationModels = new Set();
const generatedModelIds = [];
const streamedModelIds = [];
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
      signupRedirectTo = url.searchParams.get('redirect_to') || '';
      return new Response(JSON.stringify(signupResponse.body), { status:signupResponse.status, headers:{'content-type':'application/json'} });
    }
    if (url.pathname.endsWith('/auth/v1/token')) {
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        refreshRequestCount++;
        if (refreshStatus !== 200) return new Response(JSON.stringify({ code:'refresh_token_not_found', msg:'Invalid refresh token' }), { status:refreshStatus, headers:{'content-type':'application/json'} });
      }
      return new Response(JSON.stringify({
        access_token:testAccessToken,
        refresh_token:'test-refresh-token',
        expires_in:3600,
        token_type:'bearer',
        user:{ id:'user-1', email:'learner@example.test' }
      }), { status:200, headers:{'content-type':'application/json'} });
    }
    if (url.pathname.endsWith('/auth/v1/recover')) {
      recoveryRedirectTo = url.searchParams.get('redirect_to') || '';
      return new Response('{}', { status:200, headers:{'content-type':'application/json'} });
    }
    if (url.pathname.endsWith('/auth/v1/verify')) {
      return new Response(JSON.stringify({
        access_token:testAccessToken, refresh_token:'test-refresh-token', expires_in:3600,
        token_type:'bearer', user:{ id:'user-1', email:'learner@example.test' }
      }), { status:200, headers:{'content-type':'application/json'} });
    }
    if (url.pathname.endsWith('/auth/v1/logout')) {
      return new Response('{}', { status:200, headers:{'content-type':'application/json'} });
    }
    if (url.pathname.endsWith('/rpc/get_learner_snapshot_chunks')) {
      return new Response(JSON.stringify([{
        snapshot:JSON.stringify({ profile:{ name:'Learner' }, courses:[], events:[] }),
        revision:mockSnapshotRevision,
        updated_at:'2026-10-02T00:00:00Z'
      }]), { status:200, headers:{'content-type':'application/json'} });
    }
    if (url.pathname.endsWith('/rpc/get_learner_snapshot_piece')) {
      if (missingSnapshotRpc) {
        return new Response(JSON.stringify({
          code:'PGRST202',
          message:'Could not find the function public.get_learner_snapshot_piece.'
        }), { status:404, headers:{'content-type':'application/json'} });
      }
      return new Response(JSON.stringify([{
        content:JSON.stringify({ profile:{ name:'Learner' }, courses:[], events:[] }),
        chunk_count:1,
        revision:mockSnapshotRevision,
        updated_at:'2026-10-02T00:00:00Z'
      }]), { status:200, headers:{'content-type':'application/json'} });
    }
    if (url.pathname.endsWith('/rpc/commit_learner_snapshot_upload')) {
      const payload = JSON.parse(init.body);
      lastSnapshotWrite = { user_id:'user-1', ...payload };
      mockSnapshotRevision++;
      return new Response(JSON.stringify({ ok:true, revision:mockSnapshotRevision }), { status:200, headers:{'content-type':'application/json'} });
    }
    if (url.pathname.endsWith('/rest/v1/learner_snapshot_uploads')) {
      lastSnapshotWrite = { user_id:'user-1', ...JSON.parse(init.body) };
      return new Response(JSON.stringify([{ upload_id:lastSnapshotWrite.upload_id }]), { status:201, headers:{'content-type':'application/json'} });
    }
    if (url.pathname.endsWith('/rest/v1/rpc/consume_user_ai_rate_limit')) {
      if (missingAiRateLimitRpc) {
        return new Response(JSON.stringify({
          code:'PGRST202',
          message:'Could not find the function public.consume_user_ai_rate_limit.'
        }), { status:404, headers:{'content-type':'application/json'} });
      }
      return new Response('true', { status:200, headers:{'content-type':'application/json'} });
    }
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
      if (missingSnapshotRpc) {
        assert.equal(url.searchParams.get('user_id'), 'eq.user-1');
        return new Response(JSON.stringify({
          payload:{ profile:{ name:'Legacy learner' }, courses:[{ id:'existing-course' }], events:[] },
          updated_at:'2026-09-30T00:00:00Z'
        }), { status:200, headers:{'content-type':'application/json'} });
      }
      return new Response(JSON.stringify({ payload: { profile: { name: 'Learner' }, courses: [] }, updated_at: '2026-10-02T00:00:00Z' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected Supabase request: ${url.pathname}`);
  }
  if (url.hostname !== 'generativelanguage.googleapis.com') return nativeFetch(input, init);
  if (url.pathname.endsWith('/models')) {
    return new Response(JSON.stringify({
      models:[
        { name:'models/test-model', supportedGenerationMethods:['generateContent'] },
        { name:'models/backup-model', supportedGenerationMethods:['generateContent'] },
        { name:'models/not-a-generator', supportedGenerationMethods:['embedContent'] }
      ]
    }), { status:200, headers:{ 'content-type':'application/json' } });
  }
  if (url.pathname.endsWith(':countTokens')) {
    const model = url.pathname.match(/\/models\/([^/:]+):countTokens$/)?.[1];
    if (modelProbeFailures.has(model)) {
      return new Response(JSON.stringify({ error:{ message:`Model ${model} is not found.` } }), { status:404, headers:{'content-type':'application/json'} });
    }
    return new Response(providerStatus.body, { status: providerStatus.status });
  }
  const payload = JSON.parse(init.body);
  const generationModel = url.pathname.match(/\/models\/([^/:]+):generateContent$/)?.[1];
  const streamingModel = url.pathname.match(/\/models\/([^/:]+):streamGenerateContent$/)?.[1];
  if (generationModel) generatedModelIds.push(generationModel);
  if (streamingModel) streamedModelIds.push(streamingModel);
  const requestedModel = generationModel || streamingModel;
  if (unavailableGenerationModels.has(requestedModel)) {
    return new Response(JSON.stringify({ error:{ message:`Model ${requestedModel} is not found.` } }), { status:404, headers:{'content-type':'application/json'} });
  }
  generatedResponseMimeTypes.push(payload.generationConfig?.responseMimeType || null);
  assert.equal(payload.contents[0].parts[0].text.includes('test prompt'), true);
  assert.equal(new URL(url).searchParams.has('key'), false);
  assert.equal(new Headers(init.headers).get('x-goog-api-key'), 'test-server-key');
  if (generationFailure?.timeout) throw Object.assign(new Error('simulated provider timeout'), { name:'TimeoutError' });
  if (generationFailure) {
    return new Response(JSON.stringify(generationFailure.body), { status:generationFailure.status, headers:{'content-type':'application/json'} });
  }
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

test('health skips unavailable configured Gemini models and selects an advertised working model', async () => {
  modelProbeFailures.add('test-model');
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ready, true);
    assert.equal(body.provider, 'gemini');
    assert.equal(body.model, 'backup-model');
  } finally {
    modelProbeFailures.delete('test-model');
  }
});

test('missing access cookie refreshes the Supabase session from the refresh cookie', async () => {
  refreshStatus = 200;
  const previousCount = refreshRequestCount;
  const response = await fetch(`${baseUrl}/api/auth/session`, {
    headers:{ cookie:'ap_refresh=test-refresh-token', 'x-forwarded-for':'198.51.100.11' }
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.user.id, 'user-1');
  assert.equal(refreshRequestCount, previousCount + 1);
  assert.match(response.headers.get('set-cookie') || '', /ap_access=.*HttpOnly/);
  assert.match(response.headers.get('set-cookie') || '', /ap_refresh=.*HttpOnly/);
});

test('logout revokes and clears a session restored from a refresh cookie alone', async () => {
  const response = await fetch(`${baseUrl}/api/auth/logout`, {
    method:'POST',
    headers:{ 'content-type':'application/json', cookie:'ap_refresh=test-refresh-token', 'x-forwarded-for':'198.51.100.12' },
    body:'{}'
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.match(response.headers.get('set-cookie') || '', /Max-Age=0/);
});

test('invalid refresh cookies are cleared and return a JSON expired-session response', async () => {
  refreshStatus = 400;
  try {
    const response = await fetch(`${baseUrl}/api/auth/session`, {
      headers:{ cookie:'ap_refresh=invalid-refresh-token', 'x-forwarded-for':'198.51.100.13' }
    });
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.code, 'session_expired');
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.match(response.headers.get('set-cookie') || '', /Max-Age=0/);
  } finally {
    refreshStatus = 200;
  }
});

test('production session cookies retain HttpOnly, SameSite and Secure attributes', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.ok(sessionCookies({ access_token:'access', refresh_token:'refresh', expires_in:3600 })
      .every(cookie => /HttpOnly/.test(cookie) && /SameSite=Lax/.test(cookie) && /; Secure/.test(cookie)));
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('AI provider credentials come only from the server environment', async () => {
  generatedResponseMimeTypes = [];
  const response = await fetch(`${baseUrl}/api/ai/json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer valid-user-token', 'x-api-key': 'client-supplied-key' },
    body: JSON.stringify({ prompt: 'test prompt' })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(generatedResponseMimeTypes[0], 'application/json');
  const responseText = await fetch(`${baseUrl}/api/ai/text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization:`Bearer ${testAccessToken}` },
    body: JSON.stringify({ prompt: 'test prompt' })
  });
  assert.equal(responseText.status, 200, await responseText.clone().text());
  assert.deepEqual(await responseText.json(), { text:'{"ok":true}' });
  assert.equal(generatedResponseMimeTypes[1], null);
});

test('AI generation uses the per-instance rate limiter when the database rate-limit RPC is not deployed', async () => {
  missingAiRateLimitRpc = true;
  try {
    const response = await fetch(`${baseUrl}/api/ai/text`, {
      method:'POST',
      headers:{ 'content-type':'application/json', authorization:'Bearer '+testAccessToken },
      body:JSON.stringify({ prompt:'test prompt: summarize this verified lesson transcript.' })
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('x-adaptpractice-rate-limit-mode'), 'instance-fallback');
    assert.deepEqual(await response.json(), { text:'{"ok":true}' });
  } finally {
    missingAiRateLimitRpc = false;
  }
});

test('AI generation falls back to an advertised Gemini model when configured model is retired', async () => {
  generatedModelIds.length = 0;
  unavailableGenerationModels.add('test-model');
  try {
    const response = await fetch(`${baseUrl}/api/ai/text`, {
      method:'POST',
      headers:{ 'content-type':'application/json', authorization:'Bearer '+testAccessToken },
      body:JSON.stringify({ prompt:'test prompt' })
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { text:'{"ok":true}' });
    assert.deepEqual(generatedModelIds, ['test-model','backup-model']);
  } finally {
    unavailableGenerationModels.delete('test-model');
  }
});

test('Gemini quota failures identify the provider and return a quota response', async () => {
  generationFailure = { status:429, body:{ error:{ message:'Quota exceeded for this model.' } } };
  try {
    const response = await fetch(`${baseUrl}/api/ai/text`, {
      method:'POST',
      headers:{ 'content-type':'application/json', authorization:`Bearer ${testAccessToken}` },
      body:JSON.stringify({ prompt:'test prompt' })
    });
    const body = await response.json();
    assert.equal(response.status, 402);
    assert.equal(body.code, 'credits_exhausted');
    assert.match(body.error, /Gemini quota or credits/);
  } finally {
    generationFailure = null;
  }
});

test('Gemini timeouts are reported as provider timeouts with retry guidance', async () => {
  generationFailure = { timeout:true };
  try {
    const response = await fetch(`${baseUrl}/api/ai/text`, {
      method:'POST',
      headers:{ 'content-type':'application/json', authorization:`Bearer ${testAccessToken}` },
      body:JSON.stringify({ prompt:'test prompt' })
    });
    const body = await response.json();
    assert.equal(response.status, 504);
    assert.equal(body.code, 'provider_timeout');
    assert.match(body.error, /Gemini request timed out/);
  } finally {
    generationFailure = null;
  }
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

test('AI streaming falls back to another advertised model when the preferred model is retired', async () => {
  streamedModelIds.length = 0;
  unavailableGenerationModels.add('test-model');
  try {
    const response = await fetch(`${baseUrl}/api/ai/stream`, {
      method:'POST',
      headers:{ 'content-type':'application/json', authorization:'Bearer '+testAccessToken },
      body:JSON.stringify({ prompt:'test prompt' })
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(streamedModelIds, ['test-model','backup-model']);
    assert.match(body, /"delta":"streamed answer"/);
    assert.match(body, /data: \[DONE\]/);
  } finally {
    unavailableGenerationModels.delete('test-model');
  }
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
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(html.indexOf('src="source-context.js"') < html.indexOf('src="app.js"'));
  assert.ok(html.indexOf('src="course-map.js"') < html.indexOf('src="app.js"'));
  assert.ok(html.indexOf('src="snapshot-merge.js"') < html.indexOf('src="app.js"'));
  const pdfVersion = html.match(/pdf\.js\/([\d.]+)\/pdf\.min\.js/)?.[1];
  const workerVersion = app.match(/pdf\.js\/([\d.]+)\/pdf\.worker\.min\.js/)?.[1];
  assert.ok(pdfVersion);
  assert.equal(workerVersion, pdfVersion);
});

test('Express serves the repaired public frontend and shared validator before app.js', async () => {
  const htmlResponse = await fetch(`${baseUrl}/`);
  const html = await htmlResponse.text();
  const appResponse = await fetch(`${baseUrl}/app.js`);
  const appSource = await appResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.equal(appResponse.status, 200);
  assert.ok(html.indexOf('src="course-map.js"') < html.indexOf('src="app.js"'));
  const validatorPosition = appSource.indexOf('function validateCourseMap(output, wizard)');
  const builderPosition = appSource.indexOf('async function buildCourse(w)');
  assert.ok(validatorPosition >= 0 && validatorPosition < builderPosition);
  assert.match(appSource, /AdaptPracticeCourseMap\.confirmSourceImport\(w/);
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
  const originalSiteUrl = process.env.AUTH_SITE_URL;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key';
  process.env.AUTH_SITE_URL = 'https://students.example.test';
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
    assert.equal(signupRedirectTo, 'https://students.example.test/?auth=verify');
  } finally {
    if (originalPublishableKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = originalPublishableKey;
    if (originalSiteUrl === undefined) delete process.env.AUTH_SITE_URL;
    else process.env.AUTH_SITE_URL = originalSiteUrl;
  }
});

test('mocked authentication supports sign-in, sign-out, recovery email and password update', async () => {
  const previousSiteUrl = process.env.AUTH_SITE_URL;
  process.env.AUTH_SITE_URL = 'https://students.example.test';
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
  assert.equal(recoveryRedirectTo, 'https://students.example.test/?auth=reset');

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
  if (previousSiteUrl === undefined) delete process.env.AUTH_SITE_URL;
  else process.env.AUTH_SITE_URL = previousSiteUrl;
});

test('email confirmation exchanges a one-time token for a secure app session', async () => {
  const response = await fetch(`${baseUrl}/api/auth/verify`, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ token_hash:'valid-test-hash', type:'signup' })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.id, 'user-1');
  assert.match(response.headers.get('set-cookie') || '', /ap_refresh=.*HttpOnly/);
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

test('unknown API paths return JSON rather than the SPA HTML page', async () => {
  const response = await fetch(`${baseUrl}/api/not-a-real-endpoint`);
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  assert.equal((await response.json()).code, 'not_found');
});

test('authenticated users read only the RLS-scoped snapshot client', async () => {
  const response = await fetch(`${baseUrl}/api/learner/snapshot`, { headers: { authorization: 'Bearer valid-user-token' } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.user.id, 'user-1');
  assert.deepEqual(body.snapshot.profile, { name: 'Learner' });
});

test('snapshot loading falls back to the authenticated user legacy snapshot when the migration RPC is missing', async () => {
  missingSnapshotRpc = true;
  try {
    const response = await fetch(`${baseUrl}/api/learner/snapshot`, {
      headers:{ authorization:'Bearer '+testAccessToken }
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.user.id, 'user-1');
    assert.equal(body.snapshot.profile.name, 'Legacy learner');
    assert.equal(body.snapshot.courses[0].id, 'existing-course');
    assert.equal(body.hasSnapshot, true);
    assert.equal(body.revision, 0);
  } finally {
    missingSnapshotRpc = false;
  }
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

test('large snapshot chunks are stored under the authenticated account and committed by revision', async () => {
  const uploadId = 'snapshotupload0123456789';
  const content = JSON.stringify({ courses:[], events:[] });
  const headers = { 'content-type':'application/json', authorization:'Bearer '+testAccessToken };
  const chunk = await fetch(`${baseUrl}/api/learner/snapshot/chunk`, {
    method:'POST', headers,
    body:JSON.stringify({ uploadId, index:0, count:1, content })
  });
  assert.equal(chunk.status, 200);
  assert.equal(lastSnapshotWrite.user_id, 'user-1');
  assert.equal(lastSnapshotWrite.upload_id, uploadId);
  assert.equal(lastSnapshotWrite.content, content);
  const expectedRevision = mockSnapshotRevision;
  const commit = await fetch(`${baseUrl}/api/learner/snapshot/commit`, {
    method:'POST', headers,
    body:JSON.stringify({ uploadId, count:1, baseRevision:expectedRevision })
  });
  assert.equal(commit.status, 200);
  assert.equal(lastSnapshotWrite.p_upload_id, uploadId);
  assert.equal(lastSnapshotWrite.p_expected_revision, expectedRevision);
});

test('snapshot chunk endpoint validates per-request payload size', async () => {
  const response = await fetch(`${baseUrl}/api/learner/snapshot/chunk`, {
    method:'POST',
    headers:{ 'content-type':'application/json', authorization:'Bearer '+testAccessToken },
    body:JSON.stringify({
      uploadId:'0123456789abcdef',
      index:0,
      count:1,
      content:'x'.repeat(1024 * 1024 + 1)
    })
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'invalid_snapshot_chunk');
});

test.after(() => { global.fetch = nativeFetch; });
