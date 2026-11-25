'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { GeminiClient } = require('../llm/gemini-client');

test('summary generation skips a retired configured Gemini model and uses an advertised fallback', async () => {
  const requests = [];
  const client = new GeminiClient({
    GEMINI_API_KEY: 'test-key',
    GEMINI_MODEL: 'retired-model',
    LLM_MAX_RETRIES: '0'
  }, async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/models')) {
      return Response.json({ models:[
        { name:'models/first-model', supportedGenerationMethods:['generateContent'] },
        { name:'models/backup-model', supportedGenerationMethods:['generateContent'] }
      ] });
    }
    const model = parsed.pathname.match(/\/models\/([^:]+):generateContent$/)?.[1];
    requests.push(model);
    if (model === 'first-model') {
      return Response.json({ error:{ message:'Model first-model is not found.' } }, { status:404 });
    }
    return Response.json({ candidates:[{ content:{ parts:[{ text:'{"ok":true}' }] } }] });
  });

  const result = await client.generateJson({ system:'system', user:'user', promptVersion:'test' });
  assert.deepEqual(requests, ['first-model', 'backup-model']);
  assert.equal(result.model, 'backup-model');
  assert.deepEqual(result.parsed, { ok:true });
});
