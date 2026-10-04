const assert = require('node:assert/strict');
const test = require('node:test');
const { confirmSourceImport, validateCourseMap } = require('../public/course-map');

const sources = [
  {
    srcType:'pdf', fileName:'lesson.pdf', text:'PDF content',
    pages:[{ page:7, text:'A page of extracted text' }]
  },
  {
    srcType:'video', videoId:'YvvAnuOzOSY',
    videoMetadata:{ title:'Actual video title' }, text:'Manual transcript'
  },
  {
    srcType:'playlist',
    playlistItems:[
      { id:'abcdefghijk', title:'First actual title', index:1, url:'https://www.youtube.com/watch?v=abcdefghijk' },
      { id:'lmnopqrstuv', title:'Second actual title', index:2, url:'https://www.youtube.com/watch?v=lmnopqrstuv' }
    ]
  },
  { srcType:'text', text:'Learner notes' }
];

test('source confirmation validates and saves PDF, video, playlist and notes through the shared import flow', async () => {
  for (const aiEnabled of [false, true]) {
    for (const wizard of sources) {
      let saved = null;
      let buildCalls = 0;
      const result = await confirmSourceImport(wizard, {
        aiEnabled,
        buildCourse:async () => {
          buildCalls++;
          if (!aiEnabled) throw new Error('AI must not run in the disabled branch');
          if (wizard.srcType === 'playlist') return { conceptsByLesson:[['Fractions'],['Ratios']] };
          return { lessons:[{
            title:wizard.srcType === 'pdf' ? 'PDF lesson' : wizard.srcType === 'video' ? 'Video lesson' : 'Notes lesson',
            concepts:['Core idea'],
            ...(wizard.srcType === 'pdf' ? { page:7 } : {})
          }] };
        },
        save:async (output, status) => { saved = { output, status }; }
      });
      assert.ok(saved, `${wizard.srcType} must reach the save callback with AI ${aiEnabled ? 'enabled' : 'disabled'}`);
      assert.equal(saved.output, result.output);
      assert.equal(result.enriched, aiEnabled);
      assert.equal(result.attempted, aiEnabled);
      assert.equal(buildCalls, aiEnabled ? 1 : 0);
      assert.doesNotThrow(() => validateCourseMap(saved.output, wizard));
      if (wizard.srcType === 'pdf') assert.equal(saved.output.lessons[0].page, 7);
      if (wizard.srcType === 'video') assert.equal(saved.output.lessons[0].title, aiEnabled ? 'Video lesson' : 'Actual video title');
      if (wizard.srcType === 'playlist') {
        assert.deepEqual(saved.output.conceptsByLesson, aiEnabled ? [['Fractions'],['Ratios']] : undefined);
        assert.deepEqual(
          wizard.playlistItems.map(item => [item.index, item.id, item.title, item.url]),
          [[1, 'abcdefghijk', 'First actual title', 'https://www.youtube.com/watch?v=abcdefghijk'],
            [2, 'lmnopqrstuv', 'Second actual title', 'https://www.youtube.com/watch?v=lmnopqrstuv']]
        );
      }
      if (wizard.srcType === 'text') assert.equal(saved.output.lessons[0].title, aiEnabled ? 'Notes lesson' : 'Pasted notes');
    }
  }
});

test('validated material is saved when AI enrichment fails and the failure stays retryable', async () => {
  const wizard = sources[0];
  let saved = null;
  const result = await confirmSourceImport(wizard, {
    aiEnabled:true,
    buildCourse:async () => { throw Object.assign(new Error('provider timeout'), { code:'provider_timeout' }); },
    save:async (output, status) => { saved = { output, status }; }
  });
  assert.equal(result.enriched, false);
  assert.equal(result.attempted, true);
  assert.equal(result.error.code, 'provider_timeout');
  assert.equal(saved.output.lessons[0].page, 7);
  assert.equal(saved.status.enriched, false);
  assert.equal(saved.status.error, result.error);
});

test('malformed AI structure falls back to a valid source map instead of saving generated claims', async () => {
  const wizard = sources[1];
  let savedOutput;
  const result = await confirmSourceImport(wizard, {
    aiEnabled:true,
    buildCourse:async () => ({ lessons:[{ title:'Unvalidated lesson', concepts:'not-an-array' }] }),
    save:async (output, status) => { savedOutput = { output, status }; }
  });
  assert.equal(result.enriched, false);
  assert.match(result.error.message, /course map was incomplete/);
  assert.equal(savedOutput.output.lessons[0].title, 'Actual video title');
  assert.deepEqual(savedOutput.output.lessons[0].concepts, []);
  assert.equal(savedOutput.status.enriched, false);
  assert.match(savedOutput.status.error.message, /course map was incomplete/);
  assert.doesNotMatch(JSON.stringify(savedOutput.output), /Unvalidated lesson/);
});
