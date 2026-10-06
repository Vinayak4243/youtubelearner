'use strict';

const { LLMError, LLMResult } = require('./base');
const { parseJsonLoose } = require('./json-utils');

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class GeminiClient {
  constructor(env = process.env, fetchImpl = global.fetch) {
    this.key = env.GEMINI_API_KEY;
    if (!this.key) throw new LLMError('AUTH_ERROR', 'Gemini credentials are not configured.');
    this.model = env.LLM_MODEL || env.GEMINI_MODEL || 'gemma-4-26b-a4b-it';
    this.timeoutMs = Number(env.LLM_TIMEOUT_S || 60) * 1000;
    this.maxRetries = Number(env.LLM_MAX_RETRIES || 3);
    this.useSchema = String(env.LLM_USE_NATIVE_SCHEMA || 'true').toLowerCase() === 'true';
    this.fetch = fetchImpl;
  }

  async generateJson({ system, user, schema, temperature = 0.2, maxOutputTokens = 4096, promptVersion }) {
    let schemaOn = Boolean(schema && this.useSchema);
    for (let attempt = 0; ; attempt++) {
      const generationConfig = { temperature, maxOutputTokens, responseMimeType: 'application/json' };
      if (schemaOn) generationConfig.responseSchema = schema;
      const started = Date.now();
      let response;
      try {
        response = await this.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.key },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig }),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (cause) {
        if (attempt < this.maxRetries) { await delay(Math.min(30000, 500 * (2 ** attempt) + Math.random() * 250)); continue; }
        throw new LLMError('TIMEOUT', 'The summary request timed out.', { retryable: true, cause });
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 400 && schemaOn) { schemaOn = false; continue; }
        if (response.status === 401 || response.status === 403) throw new LLMError('AUTH_ERROR', 'Gemini authentication failed.');
        if (RETRYABLE.has(response.status) && attempt < this.maxRetries) { await delay(Math.min(30000, 500 * (2 ** attempt) + Math.random() * 250)); continue; }
        throw new LLMError(response.status === 429 ? 'RATE_LIMIT' : response.status >= 500 ? 'TIMEOUT' : 'LLM_ERROR', `Gemini API error ${response.status}.`, { retryable: RETRYABLE.has(response.status) });
      }
      const text = body.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
      if (!text) throw new LLMError('INVALID_MODEL_OUTPUT', 'Gemini returned no text.');
      const usage = body.usageMetadata || {};
      return new LLMResult({ text, parsed: parseJsonLoose(text), model: this.model, promptVersion, source: 'gemini', inputTokens: usage.promptTokenCount ?? null, outputTokens: usage.candidatesTokenCount ?? null, latencyMs: Date.now() - started });
    }
  }
}

module.exports = { GeminiClient };
