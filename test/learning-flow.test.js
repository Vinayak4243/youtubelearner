const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const LearningValidation = require('../public/learning-validation');
const WeaknessMatrix = require('../public/weakness-matrix');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
function loadAppFunction(signature, endMarker, context) {
  const start = appSource.indexOf(signature);
  const end = appSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `could not locate ${signature}`);
  assert.notEqual(end, -1, `could not locate the end marker ${endMarker}`);
  vm.runInNewContext(appSource.slice(start, end), context);
  return context[signature.match(/(?:function|async function)\s+(\w+)/)[1]];
}

function question(overrides = {}) {
  return {
    id:'q1', type:'short', text:'State the core idea.',
    answer:'A verified answer.', explanation:'The answer follows the source.',
    why:'This checks the core idea.', concept:'Core idea', difficulty:'medium',
    ...overrides
  };
}

function createHarness() {
  let counter = 0;
  const course = {
    id:'course-1', name:'Test course', level:'beginner', known:'none',
    goalType:'mastery', modeText:'Understand the source',
    concepts:{}, sources:[], assignments:[]
  };
  const context = {
    window:{
      AdaptPracticeLearningValidation:LearningValidation,
      AdaptPracticeWeaknessMatrix:WeaknessMatrix
    },
    course,
    uid:() => `generated-${++counter}`,
    now:() => 1000 + counter,
    findLesson:(_course,id) => id === 'lesson-1'
      ? { id, title:'A lesson', text:'Source notes', concepts:['Core idea'] }
      : null,
    rawLesson:(_course,id) => id === 'lesson-1'
      ? { lesson:{ id, title:'A lesson', text:'Source notes', concepts:['Core idea'] }, src:{ type:'text', text:'Source notes' } }
      : null,
    sourceReferenceContext:() => null,
    mmss:seconds => `00:${String(Math.floor(seconds)).padStart(2,'0')}`,
    weakList:current => Object.values(current.concepts || {}),
    D:{ profile:{ level:'beginner', goalText:'Learn the topic' }, behaviour:{ answers:1, hints:0, confusions:0 } },
    MODE_BRIEF:{ mastery:'Mastery' },
    JSON_RULE:'Reply with JSON only.',
    askJson:async () => ({ title:'Practice', questions:[question()] }),
    conceptOf(current,name) {
      return current.concepts[name] || (current.concepts[name] = {
        name, mastery:35, attempts:0, correct:0, errors:0, hints:0,
        confusion:0, status:'new', source:null, lastSeen:0,
        history:[], attemptHistory:[], errorTypes:{}
      });
    },
    ev:() => {},
    save:() => {}
  };
  loadAppFunction('function learnerCtx', 'const MODE_BRIEF', context);
  loadAppFunction('function lessonSourceText', 'function sourceReferenceContext', context);
  loadAppFunction('function questionEvidenceWhy', 'function sourceReferenceContext', context);
  loadAppFunction('async function genAssignment', 'function questionEvidenceWhy', context);
  loadAppFunction('function newAssignment', 'function sourceForAttempt', context);
  return { context, course };
}

test('actual genAssignment validates generated questions and its output creates an assignment', async () => {
  const { context, course } = createHarness();
  const genAssignment = context.genAssignment;
  const newAssignment = context.newAssignment;
  for (const opts of [{}, { lessonId:'lesson-1' }, { concept:'Core idea', count:6 }]) {
    const output = await genAssignment(course, opts);
    assert.equal(output.questions.length, 1);
    assert.equal(output.questions[0].type, 'short');
    assert.match(output.questions[0].why, /baseline check/);
    const assignment = newAssignment(course, output, opts);
    assert.equal(assignment.questions[0].text, 'State the core idea.');
    assert.equal(assignment.submitted, false);
  }
  assert.equal(course.assignments.length, 3);
});

test('playlist lesson practice uses only that video’s saved transcript', async () => {
  const { context, course } = createHarness();
  const lesson = {
    id:'playlist-lesson', title:'Actual playlist lesson', videoId:'video-id-1',
    concepts:['Core idea']
  };
  course.sources.push({
    id:'playlist-source', type:'playlist',
    transcriptsByVideoId:{
      'video-id-1':{
        text:'The selected video defines the core idea.',
        segments:[{ start:42, end:48, text:'The selected video defines the core idea.' }]
      },
      'video-id-2':{ text:'Do not include another video.' }
    }
  });
  context.findLesson = () => lesson;
  context.rawLesson = () => ({ lesson, src:course.sources[0] });
  context.sourceReferenceContext = () => ({
    type:'video',
    segments:course.sources[0].transcriptsByVideoId['video-id-1'].segments
  });
  let prompt = '';
  context.askJson = async value => {
    prompt = value;
    return { title:'Transcript practice', questions:[question({ sourceRef:{ type:'video', timestamp:44 } })] };
  };
  await context.genAssignment(course, { lessonId:lesson.id });
  assert.match(prompt, /The selected video defines the core idea/);
  assert.doesNotMatch(prompt, /Do not include another video/);
  assert.match(prompt, /00:42/);
});

test('playlist lesson summaries use the selected video transcript', async () => {
  const { context, course } = createHarness();
  const lesson = {
    id:'playlist-lesson', title:'Actual playlist lesson', videoId:'video-id-1',
    concepts:['Core idea']
  };
  const source = {
    type:'playlist',
    transcriptsByVideoId:{
      'video-id-1':{ text:'This video explains the core idea.' },
      'video-id-2':{ text:'This belongs to a different video.' }
    }
  };
  context.rawLesson = () => ({ lesson, src:source });
  context.ask = async prompt => {
    context.summaryPrompt = prompt;
    return { text:'## Key points\n- Summary from the selected video.' };
  };
  loadAppFunction('function normalizeSummary', 'async function genRoadmap', context);
  loadAppFunction('async function summarizeLesson', 'function normalizeSummary', context);
  const summary = await context.summarizeLesson(course, lesson);
  assert.match(summary, /Summary from the selected video/);
  assert.match(context.summaryPrompt, /This video explains the core idea/);
  assert.doesNotMatch(context.summaryPrompt, /This belongs to a different video/);
});

test('cloud autosave does not rerender and restart an active YouTube lesson', async () => {
  const { context } = createHarness();
  let rerenders = 0;
  let noticeUpdates = 0;
  context.AUTH = {
    user:{ id:'student-1' }, recoveryKey:'recovery', cloudRevision:2,
    syncStatus:'pending', syncError:''
  };
  context.localRevision = 3;
  context.acknowledgedRevision = 2;
  context.D = { courses:[], events:[] };
  context.S = { view:'lesson' };
  context.booted = true;
  context.window.AdaptPracticeRecoveryStore = {
    set:async () => {},
    remove:async () => {}
  };
  context.window.AdaptPracticeSnapshotSync = {
    canAcknowledgeSave:(saved,current,savedUser,currentUser) =>
      saved === current && savedUser === currentUser
  };
  context.uploadSnapshot = async () => ({ revision:3 });
  context.updateSyncNotice = () => { noticeUpdates++; };
  context.render = () => { rerenders++; };
  context.snapshotErrorMessage = error => error.message;
  loadAppFunction('async function persistSnapshot', 'function flushSnapshotSave', context);
  await context.persistSnapshot();
  assert.equal(context.AUTH.syncStatus, 'saved');
  assert.equal(rerenders, 0);
  assert.equal(noticeUpdates, 1);
});

test('next assignment prompt includes real prior assignment answers and feedback', async () => {
  const { context, course } = createHarness();
  course.assignments.push({
    id:'assignment-prior', title:'Earlier practice', submitted:true, score:0,
    questions:[question({ text:'Which rule applies?', concept:'Core idea' })],
    answers:{ 0:'The wrong rule' },
    results:[{ verdict:'incorrect', feedback:'The rule was applied in the wrong direction.' }]
  });
  let prompt = '';
  context.askJson = async value => {
    prompt = value;
    return { title:'Follow-up', questions:[question()] };
  };
  await context.genAssignment(course, {});
  assert.match(prompt, /Which rule applies/);
  assert.match(prompt, /The wrong rule/);
  assert.match(prompt, /wrong direction/);
});

test('actual gradeAssignment applies deterministic answers over contradictory AI feedback', async () => {
  const { context, course } = createHarness();
  loadAppFunction('function localVerdict', 'function recordQuestionAnswer', context);
  loadAppFunction('async function gradeAssignment', 'function pendingGrade', context);
  const questions = [
    question({ id:'mcq', type:'mcq', options:['Wrong','Right'], answer:1 }),
    question({ id:'tf', type:'tf', answer:0 }),
    question({ id:'multi', type:'multi', options:['One','Two','Three'], answer:[0,2] }),
    question({ id:'zero', type:'numeric', answer:0 }),
    question({ id:'blank', type:'mcq', options:['No','Yes'], answer:1 }),
    question({ id:'short', type:'short', answer:'A good explanation.' })
  ];
  const assignment = {
    id:'grading-test', questions,
    answers:{ 0:1, 1:0, 2:[0,2], 3:0, 4:'', 5:'A learner response' },
    hints:{}
  };
  context.askJson = async () => ({
    report:'Review the answers.',
    results:questions.map((_,i) => ({
      i, verdict:'incorrect', errorType:'recall', confidence:'high',
      feedback:'AI says incorrect.'
    }))
  });
  const result = await context.gradeAssignment(course, assignment);
  assert.deepEqual(Array.from(result.results, item => item.verdict),
    ['correct','correct','correct','correct','incorrect','incorrect']);
  assert.equal(result.results[0].confidence, 'high');
  assert.equal(result.results[0].errorType, null);
  assert.equal(result.results[5].verdict, 'incorrect');
});

test('malformed AI grading responses are rejected and numerical answer tolerance is explicit', async () => {
  const { context, course } = createHarness();
  loadAppFunction('function localVerdict', 'function recordQuestionAnswer', context);
  loadAppFunction('async function gradeAssignment', 'function pendingGrade', context);
  const localVerdict = context.localVerdict;
  assert.equal(localVerdict({ type:'numeric', answer:0 }, 0), 'correct');
  assert.equal(localVerdict({ type:'numeric', answer:1200 }, '$1,200.50'), 'correct');
  assert.equal(localVerdict({ type:'numeric', answer:1, tolerance:0.001 }, 1.001), 'correct');
  assert.equal(localVerdict({ type:'numeric', answer:1, tolerance:0.001 }, 1.01), 'incorrect');
  assert.equal(localVerdict({ type:'numeric', answer:1 }, 'not a number'), null);
  assert.equal(localVerdict({ type:'mcq', options:['A','B'], answer:1 }, undefined), 'incorrect');
  assert.equal(localVerdict({ type:'multi', answer:[0,1] }, [0]), 'partial');
  context.askJson = async () => ({ report:'incomplete', results:[] });
  await assert.rejects(
    context.gradeAssignment(course, { questions:[question({ type:'mcq', options:['A','B'], answer:1 })], answers:{ 0:0 } }),
    error => error.code === 'invalid_ai_response'
  );
  assert.throws(() => LearningValidation.normalizeQuestions({
    questions:[question({ type:'numeric', tolerance:-1 })]
  }), error => error.code === 'invalid_ai_response');
});
