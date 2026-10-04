const assert = require('node:assert/strict');
const test = require('node:test');
const { parseTimecode, parseTranscript, timestampWindow, pageText, selectPdfPages, pdfPageRange, extractPdfPages } = require('../public/source-context');

test('parses YouTube-style minute and hour timecodes', () => {
  assert.equal(parseTimecode('18:42'), 1122);
  assert.equal(parseTimecode('01:02:03.500'), 3723.5);
  assert.equal(parseTimecode('bad'), null);
});

test('parses timestamped WebVTT cues and joins cue text', () => {
  const segments = parseTranscript('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nOpening idea\ncontinued\n\n00:02:00.000 --> 00:02:05.000\nLocal idea');
  assert.deepEqual(segments, [
    { start:1, end:4, text:'Opening idea continued' },
    { start:120, end:125, text:'Local idea' }
  ]);
});

test('timestamp selection excludes unrelated video beginning', () => {
  const segments = [
    { start:0, end:20, text:'Opening unrelated material' },
    { start:80, end:100, text:'Prerequisite near the question' },
    { start:120, end:140, text:'Selected concept explanation' },
    { start:180, end:200, text:'Immediately following example' }
  ];
  const result = timestampWindow(segments, 130, { beforeSeconds:60, afterSeconds:60 });
  assert.deepEqual(result.segments.map(segment => segment.text), [
    'Prerequisite near the question', 'Selected concept explanation', 'Immediately following example'
  ]);
  assert.equal(result.text.includes('Opening unrelated material'), false);
});

test('PDF lookup returns the exact attributed page only', () => {
  const pages = [{ page:1, text:'First page' }, { page:37, text:'Relevant page' }];
  assert.equal(pageText(pages, 37), 'Relevant page');
  assert.equal(pageText(pages, 36), '');
});

test('PDF chapter mapping covers every page from a real start through the page before the next chapter', () => {
  const pages = Array.from({ length:8 }, (_, index) => ({ page:index+1, text:`content on page ${index+1}` }));
  const lessons = [{ title:'Chapter one', page:2 }, { title:'Chapter two', page:5 }];
  assert.deepEqual(pdfPageRange(lessons, 0, pages).map(page => page.page), [2,3,4]);
  assert.deepEqual(pdfPageRange(lessons, 1, pages).map(page => page.page), [5,6,7,8]);
  assert.deepEqual(pdfPageRange([{ title:'Unmapped chapter' }], 0, pages), []);
});

test('long PDF retrieval selects relevant page chunks while retaining their real page references', () => {
  const pages = [
    { page:2, text:'Foundational terms '.repeat(100) },
    { page:3, text:'A detailed example of derivative rules '.repeat(100) },
    { page:4, text:'Derivative rules and a second worked example '.repeat(100) },
    { page:5, text:'Unrelated closing notes '.repeat(100) }
  ];
  const selected = selectPdfPages(pages, 'derivative worked example', 3000);
  assert.ok(selected.some(page => page.page === 3 || page.page === 4));
  assert.ok(selected.every(page => Number.isInteger(page.page)));
  assert.ok(selected.reduce((size,page) => size + page.text.length, 0) <= 3000);
});

test('PDF extraction reads beyond page 60 and retains text beyond 14k characters', async () => {
  const progress = [];
  const document = {
    numPages:65,
    async getPage(pageNumber){
      return { async getTextContent(){ return { items:[{ str:`page-${pageNumber}-` + 'x'.repeat(300) }] }; } };
    }
  };
  const result = await extractPdfPages(document, (page, total) => progress.push([page,total]));
  assert.equal(result.pages.length, 65);
  assert.equal(result.pages[64].page, 65);
  assert.match(result.pages[64].text, /^page-65-/);
  assert.ok(result.text.length > 14000);
  assert.deepEqual(progress.at(-1), [65,65]);
});
