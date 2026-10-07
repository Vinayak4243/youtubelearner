'use strict';

class LLMError extends Error {
  constructor(code, message, { retryable = false, retryAfter = null, cause } = {}) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
    this.cause = cause;
  }
}

class LLMResult {
  constructor({ text, parsed, model, promptVersion, source, inputTokens = null, outputTokens = null, latencyMs = null }) {
    Object.assign(this, { text, parsed, model, promptVersion, source, inputTokens, outputTokens, latencyMs });
  }
}

module.exports = { LLMError, LLMResult };
