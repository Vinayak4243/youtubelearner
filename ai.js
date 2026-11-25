// server/ai.js
//
// AdaptPractice Advanced AI Engine
// Optimized for Google Gemini with OpenAI fallback.
// Implements Master Prompt pedagogical structures.

let OpenAI = null;
try { OpenAI = require('openai'); } catch (e) {}

const GEMINI_MODEL = process.env.GEMINI_MODEL || '';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || '';
const GPT_MODEL = process.env.GPT_MODEL || 'gpt-4o';
const REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS || 80000);
const STATUS_TIMEOUT_MS = 8000;
// A provider 429 is usually a short-lived RPM/TPM limit.  Keep retries
// deliberately slow so a burst from one learner does not create another one.
const GEMINI_RATE_LIMIT_RETRIES = Math.max(0, Number(process.env.GEMINI_RATE_LIMIT_RETRIES || 1));
const GEMINI_RETRY_DELAY_MS = Math.max(0, Number(process.env.GEMINI_RETRY_DELAY_MS || 15000));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
let geminiModelCache = null;

/**
 * MASTER PROMPT SYSTEM ROLE
 * Defined based on the AdaptPractice pedagogical framework.
 */
const SYSTEM_PROMPT = `You are the Lead Instructional Designer for AdaptPractice.
Your goal is to transform raw educational content (YouTube transcripts/PDFs) into structured, adaptive learning paths.

PEDAGOGICAL RULES:
1. Break complex topics into "Atomic Concepts".
2. Ensure a logical progression from Foundational -> Intermediate -> Advanced.
3. Every concept must have a clear "Learning Objective".
4. Assignments must vary in cognitive load (Recall -> Application -> Synthesis).
5. Output must be strictly formatted as JSON when requested; no prose or markdown fences.`;

/**
 * PROMPT TEMPLATES
 * These ensure the AI follows your "well-structured prompt" requirements.
 */
const TEMPLATES = {
  COURSE_GEN: (content) => `Act as an expert educator. Analyze the following material and generate a comprehensive course map.
  Material: ${content}
  
  Required JSON Structure:
  {
    "courseTitle": "String",
    "roadmap": [
      { "id": 1, "title": "Concept Name", "description": "Why this matters", "difficulty": "beginner|intermediate|advanced" }
    ],
    "gapAnalysis": "What is missing from the source that the student needs to know?"
  }`,
  
  PRACTICE_TEST: (concept, context) => `Generate a high-fidelity practice test for the concept: ${concept}.
  Context: ${context}
  
  Required JSON Structure:
  {
    "questions": [
      {
        "question": "String",
        "options": ["A", "B", "C", "D"],
        "correctAnswer": "Index",
        "explanation": "Deep dive into why this is correct",
        "difficulty": "1-5"
      }
    ]
  }`,

  EXPLAIN: (topic, level) => `Explain ${topic} to a student at ${level} level. Use a clear analogy and a concrete example. Keep it concise and engaging.`
};

/**
 * Health check to see which provider is active
 */
function getHealth() {
  return { ok: true, service: 'available' };
}

function geminiError(status, body, headers) {
  const message = body?.error?.message || `Gemini request failed (${status}).`;
  const error = new Error(message);
  const providerStatus = String(body?.error?.status || '').toLowerCase();
  const retryAfter = Number(headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfter = retryAfter;
  if (status === 401 || status === 403) error.code = 'invalid_api_key';
  else if (status === 404 || /model.*not found|unknown model/i.test(message)) error.code = 'invalid_model';
  // Gemini uses HTTP 429 for both short-lived limits and daily quota.  Do not
  // claim billing is exhausted unless the provider explicitly says so.
  else if (status === 402 || /(?:credits? (?:are )?(?:exhausted|depleted)|prepay|billing (?:is )?(?:disabled|required)|payment required)/i.test(message)) error.code = 'credits_exhausted';
  else if (status === 429 || providerStatus === 'resource_exhausted') error.code = 'rate_limited';
  else if (status === 503 || /overload|high demand/i.test(message)) error.code = 'provider_overloaded';
  else if (status >= 500) error.code = 'provider_unavailable';
  error.provider = 'gemini';
  return error;
}

async function listGeminiModels(key) {
  if (geminiModelCache && geminiModelCache.key === key && Date.now() - geminiModelCache.at < MODEL_CACHE_TTL_MS) {
    return geminiModelCache.models;
  }
  const models = [];
  let pageToken = '';
  do {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS)
    });
    if (!response.ok) throw geminiError(response.status, await response.json().catch(() => ({})));
    const data = await response.json();
    models.push(...(data.models || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  const generativeModels = models.filter(model => Array.isArray(model.supportedGenerationMethods)
    && model.supportedGenerationMethods.includes('generateContent'));
  geminiModelCache = { key, at:Date.now(), models:generativeModels };
  return generativeModels;
}

function modelId(model) {
  return String(model.name || model || '').replace(/^models\//, '');
}

function defaultGeminiModel(models) {
  return modelId(models.find(model => !/-(preview|experimental)(-|$)/i.test(modelId(model))) || models[0] || {});
}

function geminiModelCandidates(models, preferredModels = []) {
  const available = new Set(models.map(modelId).filter(Boolean));
  const stable = models.filter(model => !/-(preview|experimental)(-|$)/i.test(modelId(model)));
  const preview = models.filter(model => !stable.includes(model));
  return [...new Set([
    ...preferredModels.map(modelId),
    defaultGeminiModel(stable.length ? stable : models),
    ...stable.map(modelId),
    ...preview.map(modelId)
  ].filter(model => available.has(model)))];
}

async function verifyGeminiModel(model, key, availableModels) {
  const available = availableModels.find(candidate => modelId(candidate) === model);
  if (!available) {
    const error = new Error(`Gemini model "${model}" is not available for content generation with this API key.`);
    error.code = 'invalid_model';
    error.provider = 'gemini';
    throw error;
  }
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'health check' }] }] }),
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS)
  });
  if (!response.ok) throw geminiError(response.status, await response.json().catch(() => ({})), response.headers);
  return model;
}

async function checkProviderStatus() {
  let geminiFailure = null;
  if (process.env.GEMINI_API_KEY) {
    try {
      const availableModels = await listGeminiModels(process.env.GEMINI_API_KEY);
      const modelsToCheck = geminiModelCandidates(availableModels, [GEMINI_MODEL, GEMINI_FALLBACK_MODEL]);
      for (const model of modelsToCheck) {
        try {
          await verifyGeminiModel(model, process.env.GEMINI_API_KEY, availableModels);
          return { ready: true, provider: 'gemini', model };
        } catch (error) {
          geminiFailure = error;
          if (error.code !== 'invalid_model' && error.code !== 'provider_overloaded') break;
        }
      }
      if (!geminiFailure) {
        geminiFailure = Object.assign(new Error('Gemini exposes no models that support content generation.'), { code:'invalid_model', provider:'gemini' });
      }
    } catch (error) {
      geminiFailure = error;
    }
  }
  if (process.env.OPENAI_API_KEY && OpenAI) {
    try {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: STATUS_TIMEOUT_MS, maxRetries: 0 });
      await client.models.retrieve(GPT_MODEL);
      return { ready: true, provider: 'openai', model: GPT_MODEL };
    } catch (error) {
      return { ready: false, provider: 'openai', model: GPT_MODEL, code: error.status === 401 ? 'invalid_api_key' : error.status === 429 ? 'provider_overloaded' : 'provider_unavailable' };
    }
  }
  if (geminiFailure) {
    return { ready: false, provider: 'gemini', model: GEMINI_MODEL || undefined, code: geminiFailure.code || 'provider_unavailable' };
  }
  return { ready: false, provider: 'none', code: 'missing_api_key' };
}

async function requestGemini(prompt, maxTokens, key, model, structured = false) {
  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.7,
          ...(structured ? { responseMimeType: 'application/json' } : {})
        }
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (cause) {
    const error = new Error(cause?.name === 'TimeoutError' ? 'Gemini request timed out.' : 'Gemini could not be reached.');
    error.code = cause?.name === 'TimeoutError' ? 'provider_timeout' : 'provider_unavailable';
    error.provider = 'gemini';
    error.cause = cause;
    throw error;
  }
  if (!response.ok) throw geminiError(response.status, await response.json().catch(() => ({})));
  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw Object.assign(new Error('Gemini returned an empty response.'), { code: 'empty_completion', provider:'gemini' });
  return content.trim();
}

function geminiRetryDelay(error, attempt) {
  if (Number.isFinite(error?.retryAfter) && error.retryAfter >= 0) return error.retryAfter * 1000;
  return Math.min(30000, GEMINI_RETRY_DELAY_MS * (2 ** attempt));
}

async function askGemini(prompt, maxTokens = 2000, key, model = GEMINI_MODEL, structured = false) {
  const finalKey = key || process.env.GEMINI_API_KEY;
  if (!finalKey) throw Object.assign(new Error('GEMINI_API_KEY is missing.'), { code:'missing_api_key', provider:'gemini' });
  const availableModels = await listGeminiModels(finalKey);
  const candidates = geminiModelCandidates(availableModels, [model, GEMINI_FALLBACK_MODEL]);
  if (!candidates.length) {
    throw Object.assign(new Error('Gemini returned no models that support content generation.'), { code:'invalid_model', provider:'gemini' });
  }
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await requestGemini(prompt, maxTokens, finalKey, candidate, structured);
    } catch (error) {
      lastError = error;
      if (error.code === 'rate_limited') {
        for (let attempt = 0; attempt < GEMINI_RATE_LIMIT_RETRIES; attempt++) {
          await sleep(geminiRetryDelay(error, attempt));
          try {
            return await requestGemini(prompt, maxTokens, finalKey, candidate, structured);
          } catch (retryError) {
            lastError = retryError;
            if (retryError.code !== 'rate_limited') break;
            error = retryError;
          }
        }
      }
      if (['provider_timeout', 'provider_overloaded', 'provider_unavailable'].includes(error.code)) {
        try {
          await sleep(750);
          return await requestGemini(prompt, maxTokens, finalKey, candidate, structured);
        } catch (retryError) {
          lastError = retryError;
        }
      }
      if (!['invalid_model', 'provider_overloaded'].includes(error.code)) throw error;
    }
  }
  throw lastError;
}

async function generateText(prompt, maxTokens, customKey, structured) {
  const geminiKey = customKey && customKey.startsWith('AIza') ? customKey : process.env.GEMINI_API_KEY;
  let geminiFailure = null;
  if (geminiKey) {
    try {
      return await askGemini(prompt, maxTokens, geminiKey, GEMINI_MODEL, structured);
    } catch (error) {
      error.provider = 'gemini';
      geminiFailure = error;
      console.error('Gemini request failed:', error.code || error.status || 'unknown error');
    }
  }
  if (geminiFailure && GEMINI_FALLBACK_MODEL && ['provider_overloaded', 'invalid_model'].includes(geminiFailure.code) && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL) {
    try {
      return await askGemini(prompt, maxTokens, geminiKey, GEMINI_FALLBACK_MODEL, structured);
    } catch (fallbackError) {
      fallbackError.provider = 'gemini';
      console.error('Gemini fallback request failed:', fallbackError.code || fallbackError.status || 'unknown error');
      geminiFailure = fallbackError;
    }
  }
  const openaiKey = customKey || process.env.OPENAI_API_KEY;
  if (openaiKey && OpenAI) {
    try {
      const client = new OpenAI({ apiKey: openaiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
      const res = await client.chat.completions.create({
        model: GPT_MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
        max_tokens: maxTokens,
        ...(structured ? { response_format:{ type:'json_object' } } : {})
      });
      const content = res.choices[0]?.message?.content;
      if (!content) throw Object.assign(new Error('OpenAI returned an empty response.'), { code:'empty_completion', provider:'openai' });
      return content.trim();
    } catch (cause) {
      const error = new Error(cause.message || 'OpenAI could not complete the request.');
      error.provider = 'openai';
      error.status = cause.status;
      if (cause.status === 401 || cause.status === 403) error.code = 'invalid_api_key';
      else if (cause.status === 429) error.code = 'provider_overloaded';
      else if (cause.name === 'TimeoutError' || cause.name === 'APIConnectionTimeoutError') error.code = 'provider_timeout';
      else if (cause.status >= 500) error.code = 'provider_unavailable';
      throw error;
    }
  }
  if (geminiFailure) throw geminiFailure;
  throw Object.assign(new Error('No valid AI keys found. Please check the server environment.'), { code:'missing_api_key' });
}

/**
 * Plain-text generation.
 */
async function askText(prompt, maxTokens = 1200, customKey = null) {
  return generateText(prompt, maxTokens, customKey, false);
}

/**
 * JSON extraction and repair
 */
function extractJSON(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = Math.min(...['{', '['].map(c => { const i = t.indexOf(c); return i === -1 ? Infinity : i; }));
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start !== Infinity && end !== -1) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

async function askJSON(prompt, maxTokens = 3000, customKey = null) {
  const jsonPrompt = prompt + '\n\nReply with ONLY the JSON value. No prose, no markdown code fences.';
  let raw = await generateText(jsonPrompt, maxTokens, customKey, true);
  try {
    return extractJSON(raw);
  } catch (e) {
    const repaired = await generateText('Your previous reply was not valid JSON. Return the corrected value as JSON only:\n' + raw, maxTokens, customKey, true);
    return extractJSON(repaired);
  }
}

/**
 * Streaming support
 */
async function streamText(prompt, { onDelta, onEnd, onError, maxTokens = 600, signal: requestSignal }, customKey = null, model = GEMINI_MODEL, excludedModels = []) {
  const geminiKey = customKey && customKey.startsWith('AIza') ? customKey : process.env.GEMINI_API_KEY;
  
  if (geminiKey) {
    let emittedAny = false;
    let selectedModel = '';
    let candidates = [];
    try {
      const availableModels = await listGeminiModels(geminiKey);
      candidates = geminiModelCandidates(availableModels, [model, GEMINI_FALLBACK_MODEL])
        .filter(candidate => !excludedModels.includes(candidate));
      selectedModel = candidates[0] || '';
      if (!selectedModel) throw Object.assign(new Error('Gemini returned no models that support content generation.'), { code:'invalid_model', provider:'gemini' });
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:streamGenerateContent?alt=sse`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens }
        }),
        signal: requestSignal ? AbortSignal.any([requestSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw geminiError(res.status, data, res.headers);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const emitEvent = (event) => {
        const data = event.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim())
          .join('\n');
        if (!data || data === '[DONE]') return;
        const payload = JSON.parse(data);
        const parts = payload.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.text) {
            emittedAny = true;
            onDelta && onDelta(part.text);
          }
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream:true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop();
        for (const event of events) emitEvent(event);
      }
      buffer += decoder.decode();
      if (buffer.trim()) emitEvent(buffer);
      onEnd && onEnd();
    } catch (error) {
      error.provider = 'gemini';
      const nextModel = candidates.find(candidate => candidate !== selectedModel);
      if (!emittedAny && nextModel && ['provider_overloaded', 'invalid_model'].includes(error.code)) {
        return streamText(
          prompt,
          { onDelta, onEnd, onError, maxTokens, signal: requestSignal },
          geminiKey,
          nextModel,
          [...excludedModels, selectedModel]
        );
      }
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!emittedAny && openaiKey && OpenAI) {
        try {
          const client = new OpenAI({ apiKey: openaiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
          const stream = await client.chat.completions.create({
            model: GPT_MODEL,
            messages: [{ role:'system', content:SYSTEM_PROMPT }, { role:'user', content:prompt }],
            max_tokens:maxTokens,
            stream:true
          }, requestSignal ? { signal:requestSignal } : undefined);
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content || '';
            if (delta) onDelta && onDelta(delta);
          }
          onEnd && onEnd();
          return stream;
        } catch (cause) {
          const fallbackError = new Error(cause.message || 'OpenAI could not complete the request.');
          fallbackError.provider = 'openai';
          fallbackError.status = cause.status;
          if (cause.status === 401 || cause.status === 403) fallbackError.code = 'invalid_api_key';
          else if (cause.status === 429) fallbackError.code = 'provider_overloaded';
          else if (cause.name === 'TimeoutError' || cause.name === 'APIConnectionTimeoutError') fallbackError.code = 'provider_timeout';
          else if (cause.status >= 500) fallbackError.code = 'provider_unavailable';
          onError && onError(fallbackError);
          return;
        }
      }
      onError && onError(error);
    }
    return;
  }

  const openaiKey = customKey || process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const client = new OpenAI({ apiKey: openaiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
      const stream = await client.chat.completions.create({
        model: GPT_MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
        max_tokens: maxTokens,
        stream: true,
      }, requestSignal ? { signal: requestSignal } : undefined);
      (async () => {
        try {
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content || '';
            onDelta && onDelta(delta);
          }
          onEnd && onEnd();
        } catch (e) { onError && onError(e); }
      })();
      return stream;
    } catch (cause) {
      const error = new Error(cause.message || 'OpenAI could not complete the request.');
      error.provider = 'openai';
      error.status = cause.status;
      if (cause.status === 401 || cause.status === 403) error.code = 'invalid_api_key';
      else if (cause.status === 429) error.code = 'provider_overloaded';
      else if (cause.name === 'TimeoutError' || cause.name === 'APIConnectionTimeoutError') error.code = 'provider_timeout';
      else if (cause.status >= 500) error.code = 'provider_unavailable';
      onError && onError(error);
      return;
    }
  }
  onError && onError(new Error('No valid AI key provided for streaming.'));
}

module.exports = { askText, askJSON, streamText, TEMPLATES, MODEL: GEMINI_MODEL, getHealth, checkProviderStatus };
