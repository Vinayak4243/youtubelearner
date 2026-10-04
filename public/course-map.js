(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdaptPracticeCourseMap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function validateCourseMap(output, wizard) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('The course map was not valid. Your source is still ready; retry the import.');
    if ((output.gap !== undefined && typeof output.gap !== 'string') || (output.roadmap !== undefined && !Array.isArray(output.roadmap))) throw new Error('The course map response was incomplete. Your source is still ready; retry the import.');
    const validConcepts = value => Array.isArray(value) && value.every(item => typeof item === 'string');
    const map = { gap:typeof output.gap === 'string' ? output.gap : '', roadmap:[], lessons:[] };
    if (Array.isArray(output.roadmap)) {
      map.roadmap = output.roadmap.map(step => {
        if (!step || typeof step.title !== 'string' || typeof step.why !== 'string' || !validConcepts(step.concepts)) throw new Error('The course roadmap was incomplete. Your source is still ready; retry the import.');
        return { title:step.title, why:step.why, concepts:step.concepts.filter(Boolean).slice(0,8) };
      }).slice(0,10);
    }
    if (wizard.srcType === 'playlist') {
      if (output.conceptsByLesson !== undefined && (!Array.isArray(output.conceptsByLesson) || output.conceptsByLesson.length !== wizard.playlistItems.length || !output.conceptsByLesson.every(validConcepts))) {
        throw new Error('The AI response did not match the playlist video list. Nothing was added; retry the import.');
      }
      if (output.conceptsByLesson !== undefined) map.conceptsByLesson = output.conceptsByLesson;
      return map;
    }
    if (!Array.isArray(output.lessons) || output.lessons.some(lesson =>
      !lesson || typeof lesson.title !== 'string' || !validConcepts(lesson.concepts)
      || (lesson.page != null && (!Number.isInteger(Number(lesson.page)) || Number(lesson.page) < 1))
    )) throw new Error('The course map was incomplete. Your source is still ready; retry the import.');
    map.lessons = output.lessons.slice(0,60).map(lesson => ({
      title:lesson.title.trim(),
      concepts:lesson.concepts.filter(Boolean).slice(0,6),
      page:lesson.page == null ? null : Number(lesson.page),
      proposed:lesson.proposed === true
    }));
    return map;
  }

  function fallbackCourseMap(wizard) {
    if (wizard.srcType === 'playlist') {
      return { lessons:(wizard.playlistItems || []).map(item => ({ title:item.title, concepts:[] })), roadmap:[], gap:'' };
    }
    if (wizard.srcType === 'video') {
      return { lessons:[{ title:wizard.videoMetadata?.title || ('Video ' + wizard.videoId), concepts:[], proposed:!String(wizard.text || '').trim() }], roadmap:[], gap:'' };
    }
    if (wizard.srcType === 'pdf') {
      return { lessons:[{ title:wizard.fileName || 'Document', concepts:[], page:(wizard.pages || []).find(page => page.text.trim())?.page }], roadmap:[], gap:'' };
    }
    return { lessons:[{ title:'Pasted notes', concepts:[] }], roadmap:[], gap:'' };
  }

  async function confirmSourceImport(wizard, { aiEnabled, buildCourse, save }) {
    let output;
    let enriched = false;
    let error = null;
    if (aiEnabled) {
      try {
        output = validateCourseMap(await buildCourse(wizard), wizard);
        enriched = true;
      } catch (failure) {
        error = failure;
      }
    }
    if (!enriched) output = validateCourseMap(fallbackCourseMap(wizard), wizard);
    await save(output, { enriched, error, attempted:aiEnabled });
    return { output, enriched, error, attempted:aiEnabled };
  }

  return { validateCourseMap, fallbackCourseMap, confirmSourceImport, confirmCourseMap:confirmSourceImport };
});
