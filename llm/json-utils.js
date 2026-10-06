'use strict';

function stripFence(value) {
  return String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function firstJsonValue(value) {
  const text = stripFence(value);
  const object = text.indexOf('{');
  const array = text.indexOf('[');
  const start = object < 0 ? array : array < 0 ? object : Math.min(object, array);
  if (start < 0) throw new SyntaxError('No JSON value found.');
  const closer = text[start] === '{' ? '}' : ']';
  const end = text.lastIndexOf(closer);
  if (end < start) throw new SyntaxError('Incomplete JSON value.');
  return JSON.parse(text.slice(start, end + 1));
}

function parseJsonLoose(value) {
  // This is intentionally parser-only: never eval model output.
  return firstJsonValue(value);
}

module.exports = { stripFence, parseJsonLoose };
