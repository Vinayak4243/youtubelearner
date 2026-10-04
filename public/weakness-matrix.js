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
      mistake:verdict !== 'correct',
      category:verdict === 'correct' ? null : mistakeCategory(result.errorType),
      categoryDetail:verdict === 'correct' ? null : (result.errorType || null),
      confidence:result.confidence || null,
      attemptedAt,
      hintUsed:Boolean(assignment.hints && assignment.hints[index]),
      timing:{
        assignmentStartedAt:assignment.started || null,
        submittedAt:assignment.submittedAt || attemptedAt,
        elapsedSeconds:Number.isFinite(assignment.timeSec) ? assignment.timeSec : null
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
    } else {
      concept.errors++;
      concept.mastery = Math.max(3, mastery * 0.78 - 2);
    }
    concept.mastery = Math.max(0, Math.min(100, Math.round(concept.mastery)));
    if (attemptRecord.mistake) {
      const category = attemptRecord.category || mistakeCategory(result.errorType);
      concept.errorTypes[category] = (concept.errorTypes[category] || 0) + (result.verdict === 'partial' ? 0.5 : 1);
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
    if (concept.attempts >= 3 && concept.errors >= 2 && concept.mastery < 65) concept.status = 'weakness';
    else if (concept.errors >= 1 && concept.mastery < 70) concept.status = 'watch';
    else if (concept.attempts >= 4 && concept.mastery >= 82 && concept.errors <= 1) concept.status = 'mastered';
    else if (concept.attempts >= 2 && concept.mastery >= 70) concept.status = 'improving';
    else concept.status = concept.attempts ? 'learning' : 'new';
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

  return { mistakeCategory, answerText, createAttemptRecord, recordConceptAttempt, attemptHistory, mistakeCount };
});
