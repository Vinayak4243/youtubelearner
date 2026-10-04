(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdaptPracticeWeaknessMatrix = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CATEGORIES = new Set([
    'conceptual', 'calculation', 'application', 'recall', 'misreading',
    'logical reasoning', 'syntax', 'implementation', 'edge case',
    'careless', 'incomplete', 'other'
  ]);

  function mistakeCategory(errorType) {
    const category = String(errorType || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
    return CATEGORIES.has(category) ? category : 'other';
  }

  function answerText(question, answer) {
    if (answer === undefined || answer === '' || (Array.isArray(answer) && !answer.length)) return '(no answer)';
    const type = question.type || 'mcq';
    const options = type === 'tf' ? ['True', 'False'] : (question.options || []);
    if (type === 'multi') return (Array.isArray(answer) ? answer : []).map(index => options[index] ?? String(index)).join(', ') || '(no answer)';
    if (type === 'mcq' || type === 'tf') return options[answer] ?? String(answer);
    return Array.isArray(answer) ? answer.join(', ') : String(answer);
  }

  function createAttemptRecord({ id, course, assignment, question, answer, result, index, source, attemptedAt }) {
    const verdict = result.verdict;
    const pending = verdict === 'pending';
    const questionTiming = assignment.questionTiming?.[index] || {};
    return {
      id,
      courseId:course.id,
      courseName:course.name,
      lessonId:source.lessonId || null,
      lessonTitle:source.lessonTitle || null,
      assignmentId:assignment.id,
      questionId:question.id || `${assignment.id}:${index}`,
      questionIndex:index,
      concept:question.concept || 'General',
      question:question.text || '',
      studentAnswer:answerText(question, answer),
      correctAnswer:answerText(question, question.answer),
      explanation:question.explanation || '',
      feedback:result.feedback || question.explanation || '',
      verdict,
      gradingStatus:pending ? 'pending' : 'graded',
      mistake:!pending && verdict !== 'correct',
      category:verdict === 'correct' || pending ? null : mistakeCategory(result.errorType),
      categoryDetail:verdict === 'correct' || pending ? null : (result.errorType || null),
      confidence:result.confidence || null,
      difficulty:question.difficulty || 'medium',
      attemptedAt,
      hintUsed:Boolean(assignment.hints && assignment.hints[index]),
      answerChanges:Number(questionTiming.answerChanges) || 0,
      timing:{
        assignmentStartedAt:assignment.started || null,
        submittedAt:assignment.submittedAt || attemptedAt,
        elapsedSeconds:Number.isFinite(assignment.timeSec) ? assignment.timeSec : null,
        firstAnsweredAt:questionTiming.firstAnsweredAt || null,
        answerChangedAt:questionTiming.lastChangedAt || null,
        secondsToFirstAnswer:questionTiming.firstAnsweredAt
          ? Math.max(0, Math.round((questionTiming.firstAnsweredAt - (assignment.started || questionTiming.firstAnsweredAt)) / 1000))
          : null
      },
      source:{
        id:source.id || null,
        type:source.type || null,
        referenceType:source.referenceType || null,
        title:source.title || null,
        url:source.url || null,
        videoId:source.videoId || null,
        page:source.page || null,
        timestamp:Number.isFinite(source.timestamp) ? source.timestamp : null
      }
    };
  }

  function recordConceptAttempt(course, name, result, attemptRecord) {
    const conceptName = String(name || 'General').trim() || 'General';
    course.concepts = course.concepts || {};
    const concept = course.concepts[conceptName] || (course.concepts[conceptName] = {
      name:conceptName, mastery:35, attempts:0, correct:0, errors:0, hints:0,
      confusion:0, status:'new', source:null, lastSeen:0, history:[], errorTypes:{}
    });
    concept.attemptHistory = Array.isArray(concept.attemptHistory) ? concept.attemptHistory : [];
    concept.history = Array.isArray(concept.history) ? concept.history : [];
    concept.errorTypes = concept.errorTypes || {};
    for (const key of ['attempts', 'correct', 'errors', 'hints', 'confusion']) {
      concept[key] = Number.isFinite(Number(concept[key])) ? Number(concept[key]) : 0;
    }
    concept.attempts++;
    concept.lastSeen = attemptRecord.attemptedAt;
    if (attemptRecord.hintUsed) concept.hints++;
    const mastery = Number(concept.mastery) || 0;
    if (result.verdict === 'correct') {
      concept.correct++;
      concept.mastery = mastery + (attemptRecord.hintUsed ? (80 - mastery) * 0.14 : (94 - mastery) * 0.30);
    } else if (result.verdict === 'partial') {
      concept.errors += 0.5;
      concept.mastery = mastery + (68 - mastery) * 0.10;
    } else if (result.verdict === 'incorrect') {
      concept.errors++;
      concept.mastery = Math.max(3, mastery * 0.78 - 2);
    }
    concept.mastery = Math.max(0, Math.min(100, Math.round(concept.mastery)));
    if (attemptRecord.mistake) {
      const category = attemptRecord.category || mistakeCategory(result.errorType);
      concept.errorTypes[category] = (concept.errorTypes[category] || 0) + (result.verdict === 'partial' ? 0.5 : 1);
    }
    if (result.verdict === 'correct') {
      for (const earlier of concept.attemptHistory) {
        if (earlier.mistake && !earlier.improvedAt) {
          earlier.improvedAt = attemptRecord.attemptedAt;
          earlier.improvedByAttemptId = attemptRecord.id;
        }
      }
    }
    if (attemptRecord.source && (attemptRecord.source.lessonId || attemptRecord.source.page || attemptRecord.source.timestamp != null)) {
      concept.source = {
        lessonId:attemptRecord.lessonId || null,
        title:attemptRecord.lessonTitle || attemptRecord.source.title || null,
        page:attemptRecord.source.page || null,
        at:attemptRecord.source.timestamp
      };
    }
    concept.history.push({ t:attemptRecord.attemptedAt, v:result.verdict, m:concept.mastery, d:result.difficulty || 'medium' });
    if (concept.history.length > 40) concept.history.shift();
    concept.attemptHistory.push(attemptRecord);
    Object.assign(concept, learningState(concept));
    attemptRecord.masteryAfter = concept.mastery;
    attemptRecord.statusAfter = concept.status;
    return concept;
  }

  function learningState(concept) {
    const evidence = Array.isArray(concept.attemptHistory) && concept.attemptHistory.length
      ? concept.attemptHistory.filter(record => record.verdict !== 'pending').slice(-6)
      : (Array.isArray(concept.history) ? concept.history.slice(-6) : []);
    const recentCorrect = evidence.filter(record => record.verdict === 'correct' || record.v === 'correct');
    const recentErrors = evidence.filter(record => record.verdict === 'incorrect' || record.verdict === 'partial'
      || (record.v && record.v !== 'correct'));
    const independentCorrect = recentCorrect.filter(record => !record.hintUsed);
    const appropriatelyDifficult = independentCorrect.filter(record => record.difficulty === 'medium' || record.difficulty === 'hard' || record.d === 'medium' || record.d === 'hard');
    const mastery = Number(concept.mastery) || 0;
    let status = 'new';
    if (Number(concept.attempts) > 0 || Number(concept.confusion) > 0) status = 'learning';
    if (evidence.length >= 4 && recentErrors.length >= 2 && recentCorrect.length < 2 && mastery < 65) status = 'weakness';
    else if (evidence.length >= 2 && recentErrors.length >= 2 && mastery < 70) status = 'watch';
    else if (mastery >= 80 && independentCorrect.length >= 4 && appropriatelyDifficult.length >= 2) status = 'mastered';
    else if (recentCorrect.length >= 2 && (recentCorrect.length > recentErrors.length || mastery >= 65)) status = 'improving';
    const recentErrorWeight = recentErrors.reduce((total, record) => total + (record.verdict === 'partial' ? 0.5 : 1), 0);
    let priority = (100 - mastery) * 0.6 + recentErrorWeight * 7 + (Number(concept.confusion) || 0) * 6;
    if (status === 'weakness') priority += 18;
    if (status === 'mastered') priority -= 40;
    const ageDays = (Date.now() - (Number(concept.lastSeen) || Date.now())) / 864e5;
    priority += Math.max(0, Math.min(ageDays * 1.5, 12));
    return {
      status,
      priority:Math.round(priority),
      recentCorrect:recentCorrect.length,
      recentErrors:recentErrors.length,
      independentCorrect:independentCorrect.length
    };
  }

  function resolvePendingAttempt(course, name, id, result) {
    const concept = course.concepts?.[name];
    const record = concept && concept.attemptHistory?.find(item => item.id === id);
    if (!record || record.verdict !== 'pending' || result.verdict === 'pending') return concept || null;
    record.verdict = result.verdict;
    record.gradingStatus = 'graded';
    record.feedback = result.feedback || record.feedback;
    record.category = result.verdict === 'correct' ? null : mistakeCategory(result.errorType);
    record.categoryDetail = result.verdict === 'correct' ? null : result.errorType || null;
    record.confidence = result.confidence || record.confidence;
    record.mistake = result.verdict !== 'correct';
    concept.correct = Number(concept.correct) || 0;
    concept.errors = Number(concept.errors) || 0;
    if (result.verdict === 'correct') {
      concept.correct++;
      const mastery = Number(concept.mastery) || 0;
      concept.mastery = mastery + (record.hintUsed ? (80 - mastery) * 0.14 : (94 - mastery) * 0.30);
      for (const earlier of concept.attemptHistory) {
        if (earlier.id !== record.id && earlier.mistake && !earlier.improvedAt) {
          earlier.improvedAt = record.attemptedAt;
          earlier.improvedByAttemptId = record.id;
        }
      }
    } else {
      concept.errors += result.verdict === 'partial' ? 0.5 : 1;
      concept.mastery = result.verdict === 'partial'
        ? (Number(concept.mastery) || 0) + (68 - (Number(concept.mastery) || 0)) * 0.10
        : Math.max(3, (Number(concept.mastery) || 0) * 0.78 - 2);
      const category = record.category || 'other';
      concept.errorTypes = concept.errorTypes || {};
      concept.errorTypes[category] = (Number(concept.errorTypes[category]) || 0) + (result.verdict === 'partial' ? 0.5 : 1);
    }
    concept.mastery = Math.max(0, Math.min(100, Math.round(concept.mastery)));
    const historyItem = concept.history?.slice().reverse().find(item => item.t === record.attemptedAt && item.v === 'pending');
    if (historyItem) { historyItem.v = result.verdict; historyItem.m = concept.mastery; }
    record.masteryAfter = concept.mastery;
    Object.assign(concept, learningState(concept));
    record.statusAfter = concept.status;
    return concept;
  }

  function attemptHistory(concept) {
    return Array.isArray(concept.attemptHistory) ? concept.attemptHistory.slice().sort((a, b) => b.attemptedAt - a.attemptedAt) : [];
  }

  function mistakeCount(concept) {
    const records = attemptHistory(concept);
    return Math.max(
      records.filter(record => record.mistake).length,
      Math.round(Number(concept.errors) || 0)
    );
  }

  return { mistakeCategory, answerText, createAttemptRecord, recordConceptAttempt, resolvePendingAttempt, learningState, attemptHistory, mistakeCount };
});
