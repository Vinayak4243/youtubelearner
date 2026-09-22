// server/claude.js
//
// Multi-provider AI backend for AdaptPractice.
// Supports Anthropic Claude, Google Gemini, and local Ollama.

let Anthropic = null;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch (e) {
  Anthropic = null;
}

const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const USE_OLLAMA = String(process.env.USE_OLLAMA || '').toLowerCase() === 'true' ||
  (!IS_SERVERLESS && !process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY);

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_FALLBACK_MODELS = ['qwen2.5:3b', 'llama3.2:3b', 'llama3.1:8b', 'mistral:7b'];
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || OLLAMA_FALLBACK_MODELS[0];

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

function getActiveModel() {
  if (process.env.ANTHROPIC_API_KEY) return CLAUDE_MODEL;
  if (process.env.GEMINI_API_KEY) return GEMINI_MODEL;
  if (USE_OLLAMA) return OLLAMA_MODEL;
  return CLAUDE_MODEL;
}

const MODEL = getActiveModel();

function getHealth() {
  if (process.env.ANTHROPIC_API_KEY) {
    return { ok: true, provider: 'anthropic', model: CLAUDE_MODEL };
  }
  if (process.env.GEMINI_API_KEY) {
    return { ok: true, provider: 'gemini', model: GEMINI_MODEL };
  }
  if (USE_OLLAMA && !IS_SERVERLESS) {
    return { ok: true, provider: 'ollama', model: OLLAMA_MODEL };
  }
  return { ok: false, provider: 'none', message: 'No AI key configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY to activate AI.' };
}

function listOllamaModels() {
  return [...new Set([process.env.OLLAMA_MODEL, ...OLLAMA_FALLBACK_MODELS, OLLAMA_MODEL].filter(Boolean))];
}

async function askOllamaOnce(prompt, { stream = false, maxTokens = 1200, model }) {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream,
      options: { num_predict: maxTokens }
    })
  });

  if (!res.ok) {
    const text = await res.text();
    const message = `Ollama error: ${res.status} ${text}`;
    if (res.status === 404 || /model.*not found|unknown model/i.test(text)) {
      const err = new Error(message);
      err.code = 'MODEL_NOT_FOUND';
      throw err;
    }
    throw new Error(message);
  }

  if (!stream) {
    const data = await res.json();
    return String(data.message?.content || data.response || '').trim();
  }

  return res;
}

let anthropicClient = null;
function getAnthropicClient(customKey) {
  const key = customKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!customKey && anthropicClient) return anthropicClient;
  if (!Anthropic) Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key });
  if (!customKey) anthropicClient = client;
  return client;
}

const SYSTEM = 'You are acting as the AI backend for AdaptPractice, an adaptive learning platform. ' +
  'Follow the instructions in the user message exactly, including any JSON structure it asks for.';

async function askTextOllama(prompt, maxTokens = 1200) {
  let lastErr = null;
  for (const model of listOllamaModels()) {
    try {
      return await askOllamaOnce(prompt, { stream: false, maxTokens, model });
    } catch (err) {
      lastErr = err;
      if (err && err.code !== 'MODEL_NOT_FOUND') throw err;
    }
  }
  throw lastErr || new Error('No Ollama model available.');
}

async function askTextGemini(prompt, maxTokens = 1500, key = process.env.GEMINI_API_KEY) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini error: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return text.trim();
}

async function askText(prompt, maxTokens = 1200, customKey = null) {
  const anthropicKey = customKey && customKey.startsWith('sk-ant-') ? customKey : process.env.ANTHROPIC_API_KEY;
  const geminiKey = customKey && !customKey.startsWith('sk-ant-') ? customKey : process.env.GEMINI_API_KEY;

  if (anthropicKey) {
    const client = getAnthropicClient(anthropicKey);
    const msg = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }]
    });
    return msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  }

  if (geminiKey) {
    return askTextGemini(prompt, maxTokens, geminiKey);
  }

  if (USE_OLLAMA) {
    return askTextOllama(prompt, maxTokens);
  }

  throw new Error('No AI backend configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY to activate AI features.');
}

async function askJSON(prompt, maxTokens = 3000, customKey = null) {
  const jsonPrompt = prompt + '\n\nReply with ONLY the JSON value. No prose, no markdown code fences, nothing before or after it.';
  let raw = await askText(jsonPrompt, maxTokens, customKey);

  try {
    return extractJSON(raw);
  } catch (firstErr) {
    const repaired = await askText(
      'Your previous reply was:\n' + raw + '\n\nThat was not valid JSON. Return the corrected value as JSON only, nothing else.',
      maxTokens,
      customKey
    );
    return extractJSON(repaired);
  }
}

function extractJSON(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const candidateStarts = ['{', '['];
  const start = Math.min(...candidateStarts.map(c => { const i = t.indexOf(c); return i === -1 ? Infinity : i; }));
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start !== Infinity && end !== -1) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

function streamTextOllama(prompt, { onDelta, onEnd, onError, maxTokens = 600 }) {
  const models = listOllamaModels();
  let tried = 0;

  const run = (model) => fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      options: { num_predict: maxTokens }
    })
  })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        const text = await res.text();
        const msg = `Ollama stream error: ${res.status} ${text}`;
        if (res.status === 404 || /model.*not found|unknown model/i.test(text)) {
          const next = models[tried + 1];
          tried += 1;
          if (next) return run(next);
        }
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split('\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          const line = part.trim();
          if (!line || line === 'data: [DONE]') continue;
          if (!line.startsWith('data:')) continue;

          try {
            const payload = JSON.parse(line.slice(5));
            const delta = payload.message?.content || payload.response || '';
            if (delta) onDelta && onDelta(delta);
            if (payload.done) {
              onEnd && onEnd();
              return;
            }
          } catch (err) {}
        }
      }

      onEnd && onEnd();
    })
    .catch((err) => onError && onError(err));

  run(models[0]).catch((err) => onError && onError(err));
}

async function streamTextGemini(prompt, { onDelta, onEnd, onError, maxTokens = 700 }, key = process.env.GEMINI_API_KEY) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${key}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens }
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      return onError && onError(new Error(`Gemini stream error (${res.status}): ${errText}`));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) {
          try {
            const json = JSON.parse(trimmed.slice(5).trim());
            const delta = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (delta && onDelta) onDelta(delta);
          } catch (e) {}
        }
      }
    }
    onEnd && onEnd();
  } catch (err) {
    onError && onError(err);
  }
}

function streamText(prompt, { onDelta, onEnd, onError, maxTokens = 600 }, customKey = null) {
  const anthropicKey = customKey && customKey.startsWith('sk-ant-') ? customKey : process.env.ANTHROPIC_API_KEY;
  const geminiKey = customKey && !customKey.startsWith('sk-ant-') ? customKey : process.env.GEMINI_API_KEY;

  if (anthropicKey) {
    const client = getAnthropicClient(anthropicKey);
    const stream = client.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }]
    });
    stream.on('text', (delta) => onDelta && onDelta(delta));
    stream.on('end', () => onEnd && onEnd());
    stream.on('error', (err) => onError && onError(err));
    return stream;
  }

  if (geminiKey) {
    streamTextGemini(prompt, { onDelta, onEnd, onError, maxTokens }, geminiKey);
    return;
  }

  if (USE_OLLAMA) {
    return streamTextOllama(prompt, { onDelta, onEnd, onError, maxTokens });
  }

  onError && onError(new Error('No AI backend configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY to activate AI features.'));
}

module.exports = { askText, askJSON, streamText, MODEL, getHealth };
