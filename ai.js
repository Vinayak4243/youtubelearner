// server/ai.js
//
// AdaptPractice Advanced AI Engine
// Optimized for Google Gemini with OpenAI fallback.
// Implements Master Prompt pedagogical structures.

let OpenAI = null;
try { OpenAI = require('openai'); } catch (e) {}

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite';
const GPT_MODEL = process.env.GPT_MODEL || 'gpt-4o';
const REQUEST_TIMEOUT_MS = 30000;
const STATUS_TIMEOUT_MS = 8000;

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

function geminiError(status, body) {
  const message = body?.error?.message || `Gemini request failed (${status}).`;
  const error = new Error(message);
  if (status === 401 || status === 403) error.code = 'invalid_api_key';
  else if (status === 404 || /model.*not found|unknown model/i.test(message)) error.code = 'invalid_model';
  else if (status === 402 || /quota|credit balance|billing/i.test(message)) error.code = 'credits_exhausted';
  else if (status === 429 || status === 503 || /overload|high demand/i.test(message)) error.code = 'provider_overloaded';
  else if (status >= 500) error.code = 'provider_unavailable';
  return error;
}

async function checkGeminiModel(model, key) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'health check' }] }] }),
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS)
  });
  if (!response.ok) throw geminiError(response.status, await response.json().catch(() => ({})));
}

async function checkProviderStatus() {
  if (process.env.GEMINI_API_KEY) {
    for (const model of [GEMINI_MODEL, GEMINI_FALLBACK_MODEL]) {
      try {
        await checkGeminiModel(model, process.env.GEMINI_API_KEY);
        return { ready: true, provider: 'gemini', model };
      } catch (error) {
        if (!['provider_overloaded', 'invalid_model'].includes(error.code)) {
          return { ready: false, provider: 'gemini', model, code: error.code || 'provider_unavailable' };
        }
      }
    }
    return { ready: false, provider: 'gemini', model: GEMINI_MODEL, code: 'invalid_model' };
  }
  if (process.env.OPENAI_API_KEY && OpenAI) {
    try {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: STATUS_TIMEOUT_MS, maxRetries: 0 });
      await client.models.retrieve(GPT_MODEL);
      return { ready: true, provider: 'openai', model: GPT_MODEL };
    } catch (error) {
      return { ready: false, provider: 'openai', model: GPT_MODEL, code: error.status === 401 ? 'invalid_api_key' : 'invalid_model' };
    }
  }
  return { ready: false, provider: 'none', code: 'missing_api_key' };
}

async function requestGemini(prompt, maxTokens, key, model) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7, responseMimeType: 'application/json' }
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw geminiError(response.status, await response.json().catch(() => ({})));
  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw Object.assign(new Error('Gemini returned an empty response.'), { code: 'empty_completion' });
  return content.trim();
}

/**
 * Core Gemini Text Generation
 */
async function askGemini(prompt, maxTokens = 2000, key, model = GEMINI_MODEL) {
  const finalKey = key || process.env.GEMINI_API_KEY;
  if (!finalKey) throw new Error('GEMINI_API_KEY is missing.');
  return requestGemini(prompt, maxTokens, finalKey, model);
}

/**
 * C-Level API for text completion
 */
async function askText(prompt, maxTokens = 1200, customKey = null) {
  const geminiKey = customKey && customKey.startsWith('AIza') ? customKey : process.env.GEMINI_API_KEY;
  let geminiError = null;
  if (geminiKey) {
    try {
      return await askGemini(prompt, maxTokens, geminiKey);
    } catch (e) {
      geminiError = e;
      console.error('Gemini request failed:', e.code || e.status || 'unknown error');
    }
  }
  if (geminiError && ['provider_overloaded', 'invalid_model'].includes(geminiError.code) && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL) {
    try {
      return await askGemini(prompt, maxTokens, geminiKey, GEMINI_FALLBACK_MODEL);
    } catch (fallbackError) {
      console.error('Gemini fallback request failed:', fallbackError.code || fallbackError.status || 'unknown error');
      geminiError = fallbackError;
    }
  }

  const openaiKey = customKey || process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const client = new OpenAI({ apiKey: openaiKey });
      const res = await client.chat.completions.create({
        model: GPT_MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
        max_tokens: maxTokens,
      });
      return res.choices[0].message.content.trim();
    } catch (e) {
      const err = new Error(e.message);
      if (e.status === 401 || e.status === 403) err.code = 'invalid_api_key';
      throw err;
    }
  }

  if (geminiError) throw geminiError;
  throw new Error('No valid AI keys found. Please check your Profile or .env settings.');
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
  let raw = await askText(jsonPrompt, maxTokens, customKey);
  try {
    return extractJSON(raw);
  } catch (e) {
    const repaired = await askText('Your previous reply was not valid JSON. Return the corrected value as JSON only:\n' + raw, maxTokens, customKey);
    return extractJSON(repaired);
  }
}

/**
 * Streaming support
 */
async function streamText(prompt, { onDelta, onEnd, onError, maxTokens = 600, signal: requestSignal }, customKey = null, model = GEMINI_MODEL) {
  const geminiKey = customKey && customKey.startsWith('AIza') ? customKey : process.env.GEMINI_API_KEY;
  
  if (geminiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
    try {
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
        throw geminiError(res.status, data);
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
          if (part.text) onDelta && onDelta(part.text);
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
      if (model === GEMINI_MODEL && ['provider_overloaded', 'invalid_model'].includes(error.code) && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL) {
        return streamText(prompt, { onDelta, onEnd, onError, maxTokens, signal: requestSignal }, geminiKey, GEMINI_FALLBACK_MODEL);
      }
      onError && onError(error);
    }
    return;
  }

  const openaiKey = customKey || process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const client = new OpenAI({ apiKey: openaiKey });
      const stream = await client.chat.completions.create({
        model: GPT_MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
        max_tokens: maxTokens,
        stream: true,
      });
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
    } catch (e) { onError && onError(e); return; }
  }
  onError && onError(new Error('No valid AI key provided for streaming.'));
}

module.exports = { askText, askJSON, streamText, TEMPLATES, MODEL: GEMINI_MODEL, getHealth, checkProviderStatus };
