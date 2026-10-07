'use strict';

const { LLMError, LLMResult } = require('./base');
const { parseJsonLoose } = require('./json-utils');

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class GeminiClient {
  constructor(env = process.env, fetchImpl = global.fetch) {
    this.key = env.GEMINI_API_KEY;
    if (!this.key) throw new LLMError('AUTH_ERROR', 'Gemini credentials are not configured.');
    // A configured model always wins. When it is intentionally omitted, use
    // an actually advertised generateContent model for this key rather than a
    // hard-coded model that may not be available to the account.
    this.model = env.LLM_MODEL || env.GEMINI_MODEL || '';
    this.timeoutMs = Number(env.LLM_TIMEOUT_S || 60) * 1000;
    this.maxRetries = Number(env.LLM_MAX_RETRIES || 3);
    this.useSchema = String(env.LLM_USE_NATIVE_SCHEMA || 'true').toLowerCase() === 'true';
    this.fetch = fetchImpl;
  }

  async resolveModel() {
    if (this.model) return this.model;
    const response = await this.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
      headers: { 'x-goog-api-key': this.key }, signal:AbortSignal.timeout(this.timeoutMs)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw this.providerError(response.status, body, response.headers);
    const models = (body.models || []).filter(model => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent'));
    const selected = models.find(model => !/-(preview|experimental)(-|$)/i.test(model.name || '')) || models[0];
    if (!selected?.name) throw new LLMError('INVALID_MODEL_OUTPUT', 'Gemini exposes no content-generation model for this API key.');
    this.model = String(selected.name).replace(/^models\//, '');
    return this.model;
  }

  providerError(status, body, headers) {
    const message = String(body?.error?.message || `Gemini API error ${status}.`);
    const providerStatus = String(body?.error?.status || '').toLowerCase();
    const retryAfter = Number(headers?.get?.('retry-after'));
    const extra = { retryable: RETRYABLE.has(status) };
    if (Number.isFinite(retryAfter) && retryAfter >= 0) extra.retryAfter = retryAfter;
    if (status === 401 || status === 403) return new LLMError('AUTH_ERROR', 'Gemini authentication failed.', extra);
    if (status === 404 || /model.*not found|unknown model/i.test(message)) return new LLMError('INVALID_MODEL', 'The configured Gemini model is unavailable.', extra);
    if (status === 402 || /(?:credits? (?:are )?(?:exhausted|depleted)|prepay|billing (?:is )?(?:disabled|required)|payment required)/i.test(message)) return new LLMError('CREDITS_EXHAUSTED', 'Gemini billing or credits are exhausted.', { retryable:false });
    if (status === 429 || providerStatus === 'resource_exhausted') return new LLMError('RATE_LIMIT', 'Gemini rate or quota limit reached.', extra);
    if (status === 503) return new LLMError('PROVIDER_OVERLOADED', 'Gemini is temporarily unavailable.', extra);
    if (status >= 500) return new LLMError('TIMEOUT', 'Gemini is temporarily unavailable.', extra);
    return new LLMError('LLM_ERROR', `Gemini rejected the request (${status}).`, { retryable:false });
  }

  async generateJson({ system, user, schema, temperature = 0.2, maxOutputTokens = 4096, promptVersion }) {
    const model = await this.resolveModel();
    let schemaOn = Boolean(schema && this.useSchema);
    for (let attempt = 0; ; attempt++) {
      const generationConfig = { temperature, maxOutputTokens, responseMimeType: 'application/json' };
      if (schemaOn) generationConfig.responseSchema = schema;
      const started = Date.now();
      let response;
      try {
        response = await this.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
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
        const providerError = this.providerError(response.status, body, response.headers);
        if (RETRYABLE.has(response.status) && attempt < this.maxRetries) { await delay(Math.min(30000, 500 * (2 ** attempt) + Math.random() * 250)); continue; }
        throw providerError;
      }
      const text = body.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
      if (!text) throw new LLMError('INVALID_MODEL_OUTPUT', 'Gemini returned no text.');
      const usage = body.usageMetadata || {};
      return new LLMResult({ text, parsed: parseJsonLoose(text), model, promptVersion, source: 'gemini', inputTokens: usage.promptTokenCount ?? null, outputTokens: usage.candidatesTokenCount ?? null, latencyMs: Date.now() - started });
    }
  }
}

module.exports = { GeminiClient };
