'use strict';

const { LLMError, LLMResult } = require('./base');
const { parseJsonLoose } = require('./json-utils');

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

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
    this.rateLimitDelayMs = Math.max(0, Number(env.GEMINI_RETRY_DELAY_MS || 15000));
    this.useSchema = String(env.LLM_USE_NATIVE_SCHEMA || 'true').toLowerCase() === 'true';
    this.fetch = fetchImpl;
    this.availableModels = null;
  }

  async resolveModels() {
    if (this.availableModels && Date.now() - this.availableModels.at < MODEL_CACHE_TTL_MS) return this.availableModels.models;
    const response = await this.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
      headers: { 'x-goog-api-key': this.key }, signal:AbortSignal.timeout(this.timeoutMs)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw this.providerError(response.status, body, response.headers);
    const advertised = (body.models || [])
      .filter(model => Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent'))
      .map(model => String(model.name || '').replace(/^models\//, ''))
      .filter(Boolean);
    if (!advertised.length) throw new LLMError('INVALID_MODEL_OUTPUT', 'Gemini exposes no content-generation model for this API key.');
    const stable = advertised.filter(model => !/-(preview|experimental)(-|$)/i.test(model));
    // A configured model is a preference, never permission to keep calling a
    // retired identifier.  The remaining advertised models are the 404-safe
    // fallback sequence for video summaries.
    const models = [...new Set([this.model, ...stable, ...advertised].filter(model => advertised.includes(model)))];
    this.availableModels = { at:Date.now(), models };
    return models;
  }

  async resolveModel() {
    return (await this.resolveModels())[0];
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

  retryDelay(error, attempt) {
    if (Number.isFinite(error?.retryAfter) && error.retryAfter >= 0) return error.retryAfter * 1000;
    return error?.code === 'RATE_LIMIT'
      ? Math.min(30000, this.rateLimitDelayMs * (2 ** attempt))
      : Math.min(30000, 500 * (2 ** attempt) + Math.random() * 250);
  }

  async generateJson({ system, user, schema, temperature = 0.2, maxOutputTokens = 4096, promptVersion }) {
    const models = await this.resolveModels();
    let lastError = null;
    for (const model of models) {
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
          if (attempt < this.maxRetries) { await delay(this.retryDelay(null, attempt)); continue; }
          throw new LLMError('TIMEOUT', 'The summary request timed out.', { retryable: true, cause });
        }
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (response.status === 400 && schemaOn) { schemaOn = false; continue; }
          const providerError = this.providerError(response.status, body, response.headers);
          lastError = providerError;
          if (providerError.code === 'INVALID_MODEL') break;
          if (RETRYABLE.has(response.status) && attempt < this.maxRetries) { await delay(this.retryDelay(providerError, attempt)); continue; }
          throw providerError;
        }
        const text = body.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
        if (!text) throw new LLMError('INVALID_MODEL_OUTPUT', 'Gemini returned no text.');
        const usage = body.usageMetadata || {};
        this.model = model;
        return new LLMResult({ text, parsed: parseJsonLoose(text), model, promptVersion, source: 'gemini', inputTokens: usage.promptTokenCount ?? null, outputTokens: usage.candidatesTokenCount ?? null, latencyMs: Date.now() - started });
      }
    }
    throw lastError || new LLMError('INVALID_MODEL', 'The configured Gemini model is unavailable.');
  }
}

module.exports = { GeminiClient };
