'use strict';

const crypto = require('node:crypto');
const { getLLMClient } = require('../llm/factory');
const { LLMError } = require('../llm/base');
const { renderMaster, VERSION } = require('../prompts/summary/master_v1');

const SUMMARY_SCHEMA = {
  type:'object', properties:{
    meta:{ type:'object' }, tldr:{ type:'array', items:{ type:'string' } }, chapters:{ type:'array', items:{ type:'object' } }, topics:{ type:'array', items:{ type:'object' } },
    prerequisites:{ type:'array' }, learning_goals:{ type:'array' }, key_terms:{ type:'array' }, quick_revision:{ type:'array', items:{ type:'string' } },
    check_yourself:{ type:'array' }, answer_key:{ type:'object' }, not_covered_in_source:{ type:'array', items:{ type:'string' } }, for_your_background:{ type:'array' }
  }, required:['meta','tldr','chapters','topics','prerequisites','learning_goals','key_terms','quick_revision','check_yourself','answer_key','not_covered_in_source']
};

function cleanText(value, max = 50000) { return typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, max) : ''; }
function normalizeTimestamp(value) {
  const parts = String(value || '').trim().split(':').map(Number);
  if (!parts.every(Number.isInteger) || parts.length < 2 || parts.length > 3 || parts.some(n => n < 0)) return null;
  const seconds = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
  return Number.isFinite(seconds) ? seconds : null;
}
function displayTimestamp(seconds) { const h=Math.floor(seconds/3600), m=Math.floor(seconds%3600/60), s=seconds%60; return h ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; }

function parseTranscript(input) {
  if (Array.isArray(input)) return input.map((item, index) => ({ start:Number(item.start ?? item.startSeconds), end:Number(item.end ?? item.endSeconds ?? item.start), text:cleanText(item.text, 4000), index })).filter(item => Number.isFinite(item.start) && item.text);
  const text = cleanText(input, 200000);
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(.*)$/);
    if (!match) continue;
    const start = normalizeTimestamp(match[1]); const body = cleanText(match[2], 4000);
    if (start !== null && body) rows.push({ start, end:start, text:body, index:rows.length });
  }
  return rows.map((item, index) => ({ ...item, end: rows[index + 1]?.start ?? item.start }));
}

function transcriptLines(segments) { return segments.map(item => `[${displayTimestamp(item.start)}] ${item.text}`).join('\n'); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function uniqueStrings(value, limit) { return [...new Set((Array.isArray(value) ? value : []).filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))].slice(0, limit); }
function sourceTimestamps(segments) { return new Set(segments.map(item => displayTimestamp(item.start))); }

function validateTopic(topic, timestamps, index) {
  if (!topic || typeof topic !== 'object' || !cleanText(topic.name, 160)) return null;
  const block = topic.block && typeof topic.block === 'object' ? topic.block : {};
  const definition = block.definition && typeof block.definition === 'object' && timestamps.has(block.definition.at) && Array.isArray(block.definition.support) && block.definition.support.every(ts => timestamps.has(ts))
    ? { text:cleanText(block.definition.text, 500), at:block.definition.at, support:block.definition.support } : null;
  const keyPoints = (Array.isArray(block.key_points) ? block.key_points : []).filter(point => point && timestamps.has(point.at) && Array.isArray(point.support) && point.support.every(ts => timestamps.has(ts)) && cleanText(point.text, 300)).slice(0, 6).map(point => ({ text:cleanText(point.text, 300), at:point.at, support:point.support }));
  const start = timestamps.has(topic.start) ? topic.start : definition?.at || keyPoints[0]?.at;
  const end = timestamps.has(topic.end) ? topic.end : start;
  if (!start || (!definition && !keyPoints.length)) return null;
  return { id:cleanText(topic.id, 80) || `topic_${index + 1}`, name:cleanText(topic.name, 160), start, end, block:{ definition, key_points:keyPoints }, terms:(Array.isArray(topic.terms) ? topic.terms : []).filter(term => term && timestamps.has(term.at) && Array.isArray(term.support) && term.support.every(ts => timestamps.has(ts))).slice(0,12).map(term => ({ term:cleanText(term.term,100), definition:cleanText(term.definition,300), at:term.at, support:term.support })), commonly_confused:[], prerequisites:Array.isArray(topic.prerequisites) ? topic.prerequisites.slice(0,12) : [] };
}

function validateSummary(raw, segments, { source }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new LLMError('INVALID_MODEL_OUTPUT', 'The model response was not a JSON object.');
  const timestamps = sourceTimestamps(segments);
  const topics = segments.length ? (Array.isArray(raw.topics) ? raw.topics : []).map((topic, index) => validateTopic(topic, timestamps, index)).filter(Boolean) : [];
  if (segments.length && !topics.length) throw new LLMError('INVALID_MODEL_OUTPUT', 'No grounded topic survived verification.');
  const tldr = uniqueStrings(raw.tldr, 3).slice(0, 3);
  while (tldr.length < 3) tldr.push('Not covered in source.');
  const quickRevision = uniqueStrings(raw.quick_revision, 5).slice(0, 5);
  while (quickRevision.length < 5) quickRevision.push('Not covered in source.');
  const answerKey = raw.answer_key && typeof raw.answer_key === 'object' && !Array.isArray(raw.answer_key) ? raw.answer_key : {};
  const missing = uniqueStrings(raw.not_covered_in_source, 30);
  if (!segments.length && !missing.includes('Transcript unavailable')) missing.unshift('Transcript unavailable');
  return { meta:{ ...(raw.meta && typeof raw.meta === 'object' ? raw.meta : {}), source, prompt_version:VERSION, limited:!segments.length }, tldr, chapters:Array.isArray(raw.chapters) ? raw.chapters.slice(0,30) : [], topics, prerequisites:Array.isArray(raw.prerequisites) ? raw.prerequisites.slice(0,20) : [], learning_goals:Array.isArray(raw.learning_goals) ? raw.learning_goals.slice(0,5) : [], key_terms:Array.isArray(raw.key_terms) ? raw.key_terms.slice(0,30) : [], quick_revision:quickRevision, check_yourself:Array.isArray(raw.check_yourself) ? raw.check_yourself.slice(0,3) : [], answer_key:answerKey, not_covered_in_source:missing, for_your_background:Array.isArray(raw.for_your_background) ? raw.for_your_background.slice(0,30) : [] };
}

function publicSummary(summary) { const { answer_key, ...visible } = summary; return visible; }

async function createSummary(request, { env = process.env, client = getLLMClient(env), logger = console } = {}) {
  const segments = parseTranscript(request.transcript || request.source_segments || []);
  const transcriptStatus = segments.length ? (request.transcript_status || 'full') : 'none';
  const input = { videoMeta:request.video_meta || {}, transcriptStatus, sourceMode:client.model === 'mock' ? 'mock' : 'real', goal:cleanText(request.goal,200) || 'learning', backgroundProfile:request.background_profile || null, studentState:request.student_state || null, transcript:transcriptLines(segments) };
  const { system, user } = renderMaster(input);
  const cacheKey = hash([request.user_id || '', request.video_id || '', hash(input.transcript), input.goal, hash(JSON.stringify(input.backgroundProfile)), VERSION, client.model].join('|'));
  let result;
  try { result = await client.generateJson({ system, user, schema:SUMMARY_SCHEMA, temperature:0.2, maxOutputTokens:Number(env.LLM_MAX_OUTPUT_TOKENS || 4096), promptVersion:VERSION }); }
  catch (error) { throw error instanceof LLMError ? error : new LLMError('LLM_ERROR', 'The summary service failed.', { cause:error }); }
  let summary;
  try { summary = validateSummary(result.parsed, segments, { source:result.source }); }
  catch (error) { logger.warn?.('summary_validation_failed', { code:error.code || 'INVALID_MODEL_OUTPUT', model:result.model, promptVersion:VERSION, cacheKey }); throw error; }
  logger.info?.('summary_generated', { userId:request.user_id, model:result.model, source:result.source, promptVersion:VERSION, cacheKey, inputTokens:result.inputTokens, outputTokens:result.outputTokens, latencyMs:result.latencyMs, topics:summary.topics.length });
  return { summary:publicSummary(summary), answerKey:summary.answer_key, meta:{ source:result.source, model:result.model, promptVersion:VERSION, cacheKey } };
}

module.exports = { createSummary, parseTranscript, validateSummary, publicSummary, SUMMARY_SCHEMA };
