const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const WeaknessMatrix = require('../public/weakness-matrix');
const { mergeSnapshots } = require('../public/snapshot-merge');

function applyAttempt(course, { id, assignmentId, verdict, answer, category, timestamp, hint = false }) {
  const assignment = {
    id:assignmentId, started:timestamp - 45000, submittedAt:timestamp, timeSec:45, hints:{ 0:hint }
  };
  const question = {
    id:'question-1', concept:'Fractions', type:'mcq', text:'Which fraction equals one half?',
    options:['2/3','3/6'], answer:1, explanation:'Divide numerator and denominator by three.',
    sourceRef:{ type:'pdf', page:7 }
  };
  const result = { verdict, errorType:category, feedback:'Check whether the numerator and denominator use the same factor.' };
  const record = WeaknessMatrix.createAttemptRecord({
    id, course, assignment, question, answer, result, index:0,
    source:{
      id:'pdf-source', type:'pdf', referenceType:'pdf', title:'Fractions.pdf',
      lessonId:'lesson-1', lessonTitle:'Equivalent fractions', page:7
    },
    attemptedAt:timestamp
  });
  const concept = WeaknessMatrix.recordConceptAttempt(course, question.concept, result, record);
  return { assignment, question, result, record, concept };
}

test('wrong answer is stored in the matrix with answer, feedback, category, hint, timing, and PDF reference', () => {
  const course = {
    id:'course-1', name:'Math foundations',
    concepts:{},
    sources:[{ id:'pdf-source', type:'pdf', title:'Fractions.pdf' }]
  };
  const attempt = applyAttempt(course, {
    id:'mistake-1', assignmentId:'assignment-1', verdict:'incorrect', answer:0,
    category:'calculation', timestamp:1780500000000, hint:true
  });
  assert.equal(attempt.record.courseId, 'course-1');
  assert.equal(attempt.record.lessonId, 'lesson-1');
  assert.equal(attempt.record.concept, 'Fractions');
  assert.equal(attempt.record.question, 'Which fraction equals one half?');
  assert.equal(attempt.record.studentAnswer, '2/3');
  assert.equal(attempt.record.correctAnswer, '3/6');
  assert.match(attempt.record.explanation, /Divide numerator/);
  assert.match(attempt.record.feedback, /same factor/);
  assert.equal(attempt.record.category, 'calculation');
  assert.equal(attempt.record.attemptedAt, 1780500000000);
  assert.equal(attempt.record.hintUsed, true);
  assert.equal(attempt.record.timing.elapsedSeconds, 45);
  assert.deepEqual(attempt.record.source, {
    id:'pdf-source', type:'pdf', referenceType:'pdf', title:'Fractions.pdf',
    url:null, videoId:null, page:7, timestamp:null
  });
  assert.equal(WeaknessMatrix.mistakeCount(attempt.concept), 1);
  assert.equal(attempt.concept.errorTypes.calculation, 1);
});

test('partial video attempts retain their supported category and exact timestamp reference', () => {
  const course = { id:'course-video', name:'Video course', concepts:{} };
  const question = { type:'short', text:'Explain the idea.', answer:'A concise explanation.', concept:'Core idea', explanation:'The expected answer names the core idea.' };
  const result = { verdict:'partial', errorType:'logical reasoning', feedback:'The conclusion is right, but the link between steps is missing.' };
  const record = WeaknessMatrix.createAttemptRecord({
    id:'partial-video-1',
    course,
    assignment:{ id:'assignment-video', started:1780500000000, submittedAt:1780500060000, timeSec:60, hints:{ 0:false } },
    question,
    answer:'The conclusion alone.',
    result,
    index:0,
    source:{ id:'video-source', type:'video', referenceType:'video', title:'Lecture', url:'https://youtu.be/abc123?t=82', videoId:'abc123', lessonId:'lesson-video', lessonTitle:'Core idea', timestamp:82 },
    attemptedAt:1780500060000
  });
  const concept = WeaknessMatrix.recordConceptAttempt(course, question.concept, result, record);
  assert.equal(record.studentAnswer, 'The conclusion alone.');
  assert.equal(record.correctAnswer, 'A concise explanation.');
  assert.equal(record.category, 'logical reasoning');
  assert.equal(record.source.videoId, 'abc123');
  assert.equal(record.source.timestamp, 82);
  assert.equal(concept.errors, 0.5);
  assert.equal(WeaknessMatrix.mistakeCount(concept), 1);
  assert.equal(WeaknessMatrix.mistakeCategory('made-up label'), 'other');
});

test('later targeted correct practice shows improvement without replacing the original mistake', () => {
  const course = { id:'course-1', name:'Math foundations', concepts:{} };
  const first = applyAttempt(course, {
    id:'mistake-1', assignmentId:'assignment-1', verdict:'incorrect', answer:0,
    category:'misreading', timestamp:1780500000000
  });
  const mistakeBeforePractice = structuredClone(first.record);

  for (let index = 1; index <= 4; index++) {
    applyAttempt(course, {
      id:`practice-${index}`, assignmentId:`targeted-${index}`, verdict:'correct', answer:1,
      timestamp:1780500000000 + index * 60000
    });
  }

  const topic = course.concepts.Fractions;
  const history = WeaknessMatrix.attemptHistory(topic);
  assert.equal(history.length, 5);
  assert.deepEqual(history.find(record => record.id === 'mistake-1'), mistakeBeforePractice);
  assert.equal(WeaknessMatrix.mistakeCount(topic), 1);
  assert.equal(topic.status, 'improving');
  assert.ok(topic.mastery > 70);
  assert.equal(history.filter(record => record.verdict === 'correct').length, 4);
});

test('attempt histories merge across device and cloud snapshots without dropping or duplicating records', () => {
  const course = { id:'course-1', name:'Math foundations', concepts:{} };
  applyAttempt(course, {
    id:'mistake-1', assignmentId:'assignment-1', verdict:'partial', answer:0,
    category:'application', timestamp:1780500000000
  });
  applyAttempt(course, {
    id:'practice-1', assignmentId:'assignment-2', verdict:'correct', answer:1,
    timestamp:1780500060000
  });
  const cloud = { courses:[{
    id:course.id,
    sources:[{ id:'source-existing', title:'Existing source', lessons:[] }],
    concepts:{ Fractions:structuredClone(course.concepts.Fractions) }
  }] };
  const local = structuredClone(cloud);
  local.courses[0].sources.push({ id:'source-added', title:'New PDF material', lessons:[] });
  local.courses[0].concepts.Fractions.attemptHistory.push({
    ...structuredClone(course.concepts.Fractions.attemptHistory[0]), id:'mistake-1'
  });

  const merged = mergeSnapshots(cloud, local);
  const concept = merged.courses[0].concepts.Fractions;
  assert.deepEqual(merged.courses[0].sources.map(source => source.id), ['source-existing','source-added']);
  assert.deepEqual(concept.attemptHistory.map(record => record.id), ['mistake-1','practice-1']);
  assert.equal(concept.attempts, 2);
  assert.equal(concept.errors, 0.5);
  assert.equal(WeaknessMatrix.mistakeCount(concept), 1);
  assert.equal(WeaknessMatrix.attemptHistory(JSON.parse(JSON.stringify(concept))).length, 2);
});

test('the served application wires answer grading, topic history, source links, and targeted practice', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.ok(html.indexOf('src="weakness-matrix.js"') < html.indexOf('src="app.js"'));
  assert.match(app, /AdaptPracticeWeaknessMatrix\.createAttemptRecord/);
  assert.match(app, /function weaknessTopicHistory/);
  assert.match(app, /data-act="attempt-source"/);
  assert.match(app, /case 'attempt-source'/);
  assert.match(app, /data-act="target"/);
  assert.match(app, /item\('weakness'/);
});
