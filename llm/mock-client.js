'use strict';

const { LLMResult } = require('./base');

class MockClient {
  constructor() { this.model = 'mock'; }
  async generateJson({ user, promptVersion }) {
    const timestamps = [...String(user).matchAll(/\[(\d{2}:\d{2}(?::\d{2})?)\]/g)].map(match => match[1]);
    const at = timestamps[0] || '00:00';
    const parsed = { meta:{ video_type:'generic', type_confidence:0, limited:false, source:'mock' }, tldr:['Mock summary from supplied source.', 'Replace mock mode with Gemini for generated content.', 'Timestamps are preserved from the transcript.'], chapters:[], topics: timestamps.length ? [{ id:'topic_1', name:'Source overview', start:at, end:timestamps.at(-1), block:{ definition:{ text:'Mock source-derived overview.', at, support:[at] }, key_points:[] }, terms:[], commonly_confused:[], prerequisites:[] }] : [], prerequisites:[], learning_goals:[], key_terms:[], quick_revision:['Use Gemini for a full summary.', 'Verify source timestamps.', 'Review the source.', 'Practice concepts.', 'Return when ready.'], check_yourself:[], answer_key:{}, not_covered_in_source: timestamps.length ? [] : ['Transcript unavailable'], for_your_background:[] };
    return new LLMResult({ text:JSON.stringify(parsed), parsed, model:this.model, promptVersion, source:'mock', latencyMs:0 });
  }
}

module.exports = { MockClient };
