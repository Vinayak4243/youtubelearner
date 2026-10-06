'use strict';
const { GeminiClient } = require('./gemini-client');
const { MockClient } = require('./mock-client');
const { LLMError } = require('./base');

function getLLMClient(env = process.env, fetchImpl = global.fetch) {
  const provider = String(env.LLM_PROVIDER || 'gemini').toLowerCase();
  if (provider === 'mock') return new MockClient();
  if (provider === 'gemini') return new GeminiClient(env, fetchImpl);
  throw new LLMError('LLM_ERROR', `Unsupported LLM_PROVIDER: ${provider}`);
}

module.exports = { getLLMClient };
