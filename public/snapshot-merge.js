(function (root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports
      ? require('./weakness-matrix')
      : root.AdaptPracticeWeaknessMatrix
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdaptPracticeSnapshotMerge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (WeaknessMatrix) {
  function mergeLessons(cloudLessons, localLessons) {
    const merged = (cloudLessons || []).map(lesson => ({ ...lesson }));
    const indexes = new Map(merged.map((lesson, index) => [lesson.id, index]));
    for (const local of localLessons || []) {
      if (!indexes.has(local.id)) {
        indexes.set(local.id, merged.length);
        merged.push({ ...local });
        continue;
      }
      const index = indexes.get(local.id);
      const cloud = merged[index];
      merged[index] = {
        ...cloud,
        done:cloud.done === true || local.done === true,
        text:cloud.text || local.text,
        concepts:[...new Set([...(cloud.concepts || []), ...(local.concepts || [])])],
        sourcePages:[...new Set([...(cloud.sourcePages || []), ...(local.sourcePages || [])])]
      };
    }
    return merged;
  }

  function mergeSources(cloudSources, localSources) {
    const merged = (cloudSources || []).map(source => ({ ...source, lessons:[...(source.lessons || [])] }));
    const indexes = new Map(merged.map((source, index) => [source.id, index]));
    for (const local of localSources || []) {
      if (!indexes.has(local.id)) {
        indexes.set(local.id, merged.length);
        merged.push({ ...local, lessons:[...(local.lessons || [])] });
        continue;
      }
      const index = indexes.get(local.id);
      merged[index] = {
        ...merged[index],
        lessons:mergeLessons(merged[index].lessons, local.lessons)
      };
    }
    return merged;
  }

  function mergeAssignments(cloudAssignments, localAssignments) {
    const merged = (cloudAssignments || []).map(assignment => ({ ...assignment }));
    const indexes = new Map(merged.map((assignment, index) => [assignment.id, index]));
    for (const local of localAssignments || []) {
      if (!indexes.has(local.id)) {
        indexes.set(local.id, merged.length);
        merged.push({ ...local });
        continue;
      }
      const index = indexes.get(local.id);
      const cloud = merged[index];
      const localIsNewer = local.submitted === true && cloud.submitted !== true;
      merged[index] = {
        ...cloud,
        answers:{ ...(cloud.answers || {}), ...(local.answers || {}) },
        hints:{ ...(cloud.hints || {}), ...(local.hints || {}) },
        submitted:cloud.submitted === true || local.submitted === true,
        ...(localIsNewer ? { results:local.results, score:local.score, report:local.report } : {})
      };
    }
    return merged;
  }

  function mergeAttemptRecords(cloudRecords, localRecords) {
    const merged = [];
    const seen = new Set();
    for (const record of [...(cloudRecords || []), ...(localRecords || [])]) {
      const key = record.id || JSON.stringify(record);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(record);
    }
    return merged.sort((a, b) => Number(a.attemptedAt || 0) - Number(b.attemptedAt || 0));
  }

  function mergeConcepts(cloudConcepts, localConcepts) {
    const merged = { ...(cloudConcepts || {}) };
    for (const [name, local] of Object.entries(localConcepts || {})) {
      const cloud = merged[name];
      if (!cloud) {
        merged[name] = { ...local, attemptHistory:mergeAttemptRecords([], local.attemptHistory) };
        continue;
      }
      const localHasMoreEvidence = Number(local.attempts || 0) > Number(cloud.attempts || 0);
      const primary = localHasMoreEvidence ? local : cloud;
      const attemptHistory = mergeAttemptRecords(cloud.attemptHistory, local.attemptHistory);
      const recordedCorrect = attemptHistory.filter(record => record.verdict === 'correct').length;
      const recordedErrors = attemptHistory.reduce((total, record) => total + (record.verdict === 'partial' ? 0.5 : record.mistake ? 1 : 0), 0);
      const recordedHints = attemptHistory.filter(record => record.hintUsed).length;
      const errorTypes = { ...(cloud.errorTypes || {}) };
      for (const [category, count] of Object.entries(local.errorTypes || {})) {
        errorTypes[category] = Math.max(Number(errorTypes[category] || 0), Number(count || 0));
      }
      const recordedCategories = new Set(attemptHistory.filter(record => record.mistake && record.category).map(record => record.category));
      for (const category of recordedCategories) {
        errorTypes[category] = Math.max(
          Number(errorTypes[category] || 0),
          attemptHistory.filter(record => record.mistake && record.category === category)
            .reduce((total, record) => total + (record.verdict === 'partial' ? 0.5 : 1), 0)
        );
      }
      merged[name] = {
        ...cloud,
        ...primary,
        attempts:Math.max(Number(cloud.attempts || 0), Number(local.attempts || 0), attemptHistory.length),
        correct:Math.max(Number(cloud.correct || 0), Number(local.correct || 0), recordedCorrect),
        errors:Math.max(Number(cloud.errors || 0), Number(local.errors || 0), recordedErrors),
        hints:Math.max(Number(cloud.hints || 0), Number(local.hints || 0), recordedHints),
        errorTypes,
        attemptHistory,
        confusion:Math.max(Number(cloud.confusion || 0), Number(local.confusion || 0)),
        source:cloud.source || local.source
      };
      Object.assign(merged[name], WeaknessMatrix.learningState(merged[name]));
    }
    return merged;
  }

  function mergeCourse(cloud, local) {
    return {
      ...cloud,
      sources:mergeSources(cloud.sources, local.sources),
      assignments:mergeAssignments(cloud.assignments, local.assignments),
      concepts:mergeConcepts(cloud.concepts, local.concepts),
      ...(local.roadmap?.length && !cloud.roadmap?.length ? { roadmap:local.roadmap, gap:local.gap } : {}),
      ...(local.resume?.t > (cloud.resume?.t || 0) ? { resume:local.resume } : {})
    };
  }

  function mergeSnapshots(cloudSnapshot, localSnapshot) {
    const merged = {
      profile:null, courses:[], events:[],
      behaviour:{ answers:0, correct:0, hints:0, explains:0, confusions:0, revisions:0, secs:0, modes:{} },
      settings:{ theme:'light', focus:false },
      ...(cloudSnapshot || {})
    };
    merged.courses = Array.isArray(merged.courses) ? merged.courses.slice() : [];
    merged.events = Array.isArray(merged.events) ? merged.events.slice() : [];
    const local = localSnapshot || {};
    const courseIndexes = new Map(merged.courses.map((course, index) => [course.id, index]));
    for (const course of Array.isArray(local.courses) ? local.courses : []) {
      if (!course.id || !courseIndexes.has(course.id)) {
        if (course.id) {
          courseIndexes.set(course.id, merged.courses.length);
          merged.courses.push(course);
        }
        continue;
      }
      const index = courseIndexes.get(course.id);
      merged.courses[index] = mergeCourse(merged.courses[index], course);
    }
    const eventKey = event => event.id || JSON.stringify(event);
    const eventIds = new Set(merged.events.map(eventKey));
    for (const event of Array.isArray(local.events) ? local.events : []) {
      const key = eventKey(event);
      if (!eventIds.has(key)) {
        merged.events.push(event);
        eventIds.add(key);
      }
    }
    merged.events.sort((a,b) => Number(b.t || 0) - Number(a.t || 0));
    if (!merged.profile) merged.profile = local.profile || null;
    merged.behaviour = { ...(merged.behaviour || {}) };
    const localBehaviour = local.behaviour || {};
    for (const key of ['answers','correct','hints','explains','confusions','revisions','secs']) {
      merged.behaviour[key] = Math.max(Number(merged.behaviour[key] || 0), Number(localBehaviour[key] || 0));
    }
    merged.behaviour.modes = { ...(merged.behaviour.modes || {}) };
    for (const [mode, count] of Object.entries(localBehaviour.modes || {})) {
      merged.behaviour.modes[mode] = Math.max(Number(merged.behaviour.modes[mode] || 0), Number(count || 0));
    }
    if (local.settings) merged.settings = { ...(merged.settings || {}), ...local.settings };
    return merged;
  }

  return { mergeSnapshots, mergeAttemptRecords };
});
