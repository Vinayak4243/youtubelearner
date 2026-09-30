// server/claude.js
//
// Multi-provider AI backend for AdaptPractice.
// FORCED GEMINI MODE: Prioritizes Gemini for all requests.

let OpenAI = null;
try { OpenAI = require('openai'); } catch (e) {}

const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const USE_OLLAMA = String(process.env.USE_OLLAMA || '').toLowerCase() === 'true';

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
const GPT_MODEL = process.env.GPT_MODEL || 'gpt-4o';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

function getHealth() {
  if (process.env.GEMINI_API_KEY) return { ok: true, provider: 'gemini', model: GEMINI_MODEL };
  if (process.env.OPENAI_API_KEY) return { ok: true, provider: 'openai', model: GPT_MODEL };
  if (USE_OLLAMA && !IS_SERVERLESS) return { ok: true, provider: 'ollama', model: OLLAMA_MODEL };
  return { ok: false, provider: 'none', message: 'No AI key configured.' };
}

const SYSTEM = 'You are acting as the AI backend for AdaptPractice, an adaptive learning platform. Follow the instructions exactly.';

async function askTextGemini(prompt, maxTokens = 1500, key) {
  const finalKey = key || process.env.GEMINI_API_KEY;
  if (!finalKey) throw new Error('Gemini API key is missing.');
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${finalKey}`;
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
    const text = await res.text();
    const err = new Error(`Gemini Error ${res.status}: ${text}`);
    if (res.status === 401 || res.status === 403) err.code = 'invalid_api_key';
    throw err;
  }
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
}

async function askText(prompt, maxTokens = 1200, customKey = null) {
  // FORCE GEMINI IF KEY PROVIDED
  const key = customKey || process.env.GEMINI_API_KEY;
  if (key && (key.startsWith('AIza') || !process.env.OPENAI_API_KEY)) {
    return askTextGemini(prompt, maxTokens, key);
  }

  // FALLBACK TO OPENAI
  const openaiKey = customKey || process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const client = new OpenAI({ apiKey: openaiKey });
      const res = await client.chat.completions.create({
        model: GPT_MODEL,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
        max_tokens: maxTokens,
      });
      return res.choices[0].message.content.trim();
    } catch (e) {
      const err = new Error(e.message);
      if (e.status === 401 || e.status === 403) err.code = 'invalid_api_key';
      throw err;
    }
  }

  throw new Error('No valid AI key provided. Please check your Profile or .env file.');
}

async function askJSON(prompt, maxTokens = 3000, customKey = null) {
  const jsonPrompt = prompt + '\n\nReply with ONLY the JSON value. No prose, no markdown code fences.';
  let raw = await askText(jsonPrompt, maxTokens, customKey);
  try { return extractJSON(raw); } catch (e) {
    const repaired = await askText('Your previous reply was not valid JSON. Return the corrected value as JSON only:\n' + raw, maxTokens, customKey);
    return extractJSON(repaired);
  }
}

function extractJSON(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = Math.min(...['{', '['].map(c => { const i = t.indexOf(c); return i === -1 ? Infinity : i; }));
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start !== Infinity && end !== -1) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

async function streamText(prompt, { onDelta, onEnd, onError, maxTokens = 600 }, customKey = null) {
  const key = customKey || process.env.GEMINI_API_KEY;
  if (key && (key.startsWith('AIza') || !process.env.OPENAI_API_KEY)) {
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
      if (!res.ok) throw new Error(`Gemini Stream Error: ${res.status}`);
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
          if (line.trim().startsWith('data:')) {
            try {
              const json = JSON.parse(line.trim().slice(5));
              const delta = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
              onDelta && onDelta(delta);
            } catch(e){}
          }
        }
      }
      onEnd && onEnd();
    } catch (e) { onError && onError(e); }
    return;
  }

  const openaiKey = customKey || process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const client = new OpenAI({ apiKey: openaiKey });
      const stream = await client.chat.completions.create({
        model: GPT_MODEL,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
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
  onError && onError(new Error('No valid AI key provided.'));
}

module.exports = { askText, askJSON, streamText, MODEL: 'gemini-1.5-flash', getHealth };
