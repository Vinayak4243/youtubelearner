const assert = require('node:assert/strict');
const test = require('node:test');
const { field, hashForMode, modeFromHash } = require('../public/auth-routes');
const { normalizePlaylistUrl, videoId } = require('../public/youtube-url');
const { normalizeGrade, normalizeQuestions } = require('../public/learning-validation');

test('authentication screens have distinct refreshable hash routes', () => {
  for (const [mode, route] of [
    ['signup', 'signup'],
    ['login', 'signin'],
    ['forgot', 'forgot-password'],
    ['reset', 'reset-password']
  ]) {
    assert.equal(hashForMode(mode), '#/' + route);
    assert.equal(modeFromHash('#/' + route), mode);
  }
  assert.equal(modeFromHash('#/unknown'), null);
});

test('visible field labels target the matching input ids', () => {
  for (const [label, id, type] of [
    ['Name', 'auth-name', 'text'],
    ['Email', 'auth-email', 'email'],
    ['Password', 'auth-password', 'password'],
    ['Confirm password', 'auth-confirm', 'password']
  ]) {
    const markup = field(label, '<input type="' + type + '" id="' + id + '">', value => value);
    assert.match(markup, new RegExp('<label[^>]*for="' + id + '">' + label + '<\\/label>'));
    assert.match(markup, new RegExp('<input[^>]*id="' + id + '"'));
  }
});

test('YouTube playlist URLs are canonicalized only for known YouTube hosts', () => {
  assert.equal(
    normalizePlaylistUrl('https://www.youtube.com/playlist?list=PL1234567890'),
    'https://www.youtube.com/playlist?list=PL1234567890'
  );
  assert.equal(
    normalizePlaylistUrl('https://m.youtube.com/watch?v=abcdefghijk&list=PL1234567890'),
    'https://www.youtube.com/playlist?list=PL1234567890'
  );
  assert.equal(normalizePlaylistUrl('https://example.com/?list=PL1234567890'), null);
  assert.equal(normalizePlaylistUrl('javascript:alert(1)?list=PL1234567890'), null);
  assert.equal(normalizePlaylistUrl('https://user@youtube.com/?list=PL1234567890'), null);
});

test('video links require a supported YouTube host and valid video ID', () => {
  assert.equal(videoId('abcdefghijk'), 'abcdefghijk');
  assert.equal(videoId('https://youtu.be/abcdefghijk'), 'abcdefghijk');
  assert.equal(videoId('https://www.youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
  assert.equal(videoId('https://example.com/watch?v=abcdefghijk'), null);
});

test('generated questions require valid answers, explanations and real source references', () => {
  const base = {
    type: 'mcq',
    text: 'Which value is the derivative of x squared at x=2?',
    options: ['2', '4'],
    answer: 'B',
    concept: 'Derivatives',
    why: 'You are practising the derivative rule.',
    explanation: 'The derivative is 2x, which equals 4 at x=2.'
  };
  const [question] = normalizeQuestions({
    questions: [{ ...base, sourceRef: { type: 'pdf', page: 4 } }]
  }, null, { type: 'pdf', pages: [{ page: 4, text: 'The derivative of x squared is 2x.' }] });
  assert.equal(question.answer, 1);
  assert.deepEqual(question.sourceRef, { type: 'pdf', page: 4 });

  assert.throws(
    () => normalizeQuestions({ questions: [{ ...base, answer: 9, sourceRef: { type: 'pdf', page: 99 } }] }, null,
      { type: 'pdf', pages: [{ page: 4, text: 'Some source text.' }] }),
    error => error.code === 'invalid_ai_response'
  );
  assert.throws(
    () => normalizeQuestions({ questions: [{ ...base, sourceRef: { type: 'video', timestamp: 50 } }] }, null,
      { type: 'video', segments: [{ start: 0, end: 10, text: 'Source segment.' }] }),
    error => error.code === 'invalid_ai_response'
  );
});

test('objective grading uses the answer key and invalid AI grading is rejected', () => {
  const questions = [{ type: 'mcq', answer: 1 }];
  const grade = normalizeGrade({
    results: [{
      i: 0,
      verdict: 'incorrect',
      errorType: 'careless',
      confidence: 'low',
      feedback: 'The selected option does not match the answer.'
    }],
    report: 'One objectively checked answer.'
  }, questions, () => 'correct');
  assert.equal(grade.results[0].verdict, 'correct');
  assert.equal(grade.results[0].confidence, 'high');
  assert.equal(grade.results[0].errorType, null);
  assert.throws(
    () => normalizeGrade({ results: [], report: '' }, questions, () => null),
    error => error.code === 'invalid_ai_response'
  );
});
