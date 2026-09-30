// server/ai.js
//
// AdaptPractice Advanced AI Engine
// Optimized for Google Gemini with OpenAI fallback.
// Implements Master Prompt pedagogical structures.

let OpenAI = null;
try { OpenAI = require('openai'); } catch (e) {}

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const GPT_MODEL = process.env.GPT_MODEL || 'gpt-4o';

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
  if (process.env.GEMINI_API_KEY) return { ok: true, provider: 'gemini', model: GEMINI_MODEL };
  if (process.env.OPENAI_API_KEY) return { ok: true, provider: 'openai', model: GPT_MODEL };
  return { ok: false, provider: 'none', message: 'No AI API key configured.' };
}

/**
 * Core Gemini Text Generation
 */
async function askGemini(prompt, maxTokens = 2000, key) {
  const finalKey = key || process.env.GEMINI_API_KEY;
  if (!finalKey) throw new Error('GEMINI_API_KEY is missing.');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${finalKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { 
        maxOutputTokens: maxTokens,
        temperature: 0.7,
        responseMimeType: "application/json"
      }
    })
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Gemini API Error ${res.status}: ${text}`);
    if (res.status === 401 || res.status === 403) err.code = 'invalid_api_key';
    throw err;
  }

  const data = await res.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Gemini returned an empty response.');
  return content.trim();
}

/**
 * C-Level API for text completion
 */
async function askText(prompt, maxTokens = 1200, customKey = null) {
  const geminiKey = customKey && customKey.startsWith('AIza') ? customKey : process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      return await askGemini(prompt, maxTokens, geminiKey);
    } catch (e) {
      console.error('Gemini failed, trying fallback...', e.message);
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
async function streamText(prompt, { onDelta, onEnd, onError, maxTokens = 600 }, customKey = null) {
  const geminiKey = customKey && customKey.startsWith('AIza') ? customKey : process.env.GEMINI_API_KEY;
  
  if (geminiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${geminiKey}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
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
        buffer += decoder.decode(value, { stream:true });
        const lines = buffer.split('\n\n'); buffer = lines.pop();
        for (const line of lines){
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') { resolve({ text: full }); return; }
          try {
            const j = JSON.parse(payload);
            if (j.delta) { full += j.delta; opts.onText({ text: full }); }
            if (j.error) { reject({ code:'upstream_error', message:j.error }); return; }
          } catch(e) {}
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

module.exports = { askText, askJSON, streamText, TEMPLATES, MODEL: GEMINI_MODEL, getHealth };
