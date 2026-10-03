(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdaptPracticeLearningValidation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const QUESTION_TYPES = new Set(['mcq', 'multi', 'tf', 'short', 'numeric', 'code']);
  const VERDICTS = new Set(['correct', 'partial', 'incorrect']);
  const CONFIDENCE = new Set(['low', 'medium', 'high']);
  const ERROR_TYPES = new Set([
    'conceptual', 'application', 'calculation', 'logical reasoning', 'recall',
    'misreading', 'syntax', 'implementation', 'edge case', 'careless', 'incomplete'
  ]);

  function invalidResponse() {
    return Object.assign(new Error('The AI returned an incomplete or invalid learning response. Retry the request.'), {
      code: 'invalid_ai_response'
    });
  }

  function optionIndex(value, options) {
    if (Number.isInteger(value)) return value;
    const text = String(value || '').trim();
    let index = options.findIndex(option => option.trim().toLowerCase() === text.toLowerCase());
    if (index < 0 && /^[A-Ha-h][).:]?$/.test(text)) index = text.toUpperCase().charCodeAt(0) - 65;
    return index;
  }

  function normalizeQuestions(output, fallbackConcept, sourceContext) {
    if (!output || !Array.isArray(output.questions) || !output.questions.length || output.questions.length > 30) {
      throw invalidResponse();
    }
    return output.questions.map(question => {
      if (!question || typeof question.text !== 'string' || !question.text.trim()
        || typeof question.explanation !== 'string' || !question.explanation.trim()
        || typeof question.why !== 'string' || !question.why.trim()) throw invalidResponse();

      const type = String(question.type || '').toLowerCase();
      if (!QUESTION_TYPES.has(type)) throw invalidResponse();
      const normalized = {
        ...question,
        type,
        text: question.text.trim(),
        concept: typeof question.concept === 'string' && question.concept.trim()
          ? question.concept.trim()
          : String(fallbackConcept || 'General'),
        difficulty: ['easy', 'medium', 'hard'].includes(question.difficulty) ? question.difficulty : 'medium'
      };

      if (type === 'tf') {
        const answer = question.answer;
        if (answer === 0 || answer === true || /^(true|yes|t)$/i.test(String(answer))) normalized.answer = 0;
        else if (answer === 1 || answer === false || /^(false|no|f)$/i.test(String(answer))) normalized.answer = 1;
        else throw invalidResponse();
        normalized.options = ['True', 'False'];
      } else if (type === 'mcq' || type === 'multi') {
        if (!Array.isArray(question.options) || question.options.length < 2
          || question.options.length > 8
          || question.options.some(option => typeof option !== 'string' || !option.trim())) throw invalidResponse();
        normalized.options = question.options.map(option => option.trim());
        const answer = type === 'multi'
          ? (Array.isArray(question.answer) ? question.answer : [question.answer]).map(value => optionIndex(value, normalized.options))
          : optionIndex(question.answer, normalized.options);
        if (type === 'mcq') {
          if (!Number.isInteger(answer) || answer < 0 || answer >= normalized.options.length) throw invalidResponse();
          normalized.answer = answer;
        } else {
          const indices = [...new Set(answer)];
          if (!indices.length || indices.some(index => !Number.isInteger(index) || index < 0 || index >= normalized.options.length)) throw invalidResponse();
          normalized.answer = indices;
        }
      } else {
        if (question.answer === undefined || question.answer === null || !String(question.answer).trim()) throw invalidResponse();
        if (type === 'numeric' && !Number.isFinite(Number(question.answer))) throw invalidResponse();
      }
      if (question.hint !== undefined && typeof question.hint !== 'string') throw invalidResponse();
      const reference = question.sourceRef;
      if (sourceContext?.type === 'pdf') {
        const page = Number(reference?.page);
        const sourcePage = sourceContext.pages.find(item => item.page === page && item.text.trim());
        if (reference?.type !== 'pdf' || !Number.isInteger(page) || !sourcePage) throw invalidResponse();
        normalized.sourceRef = { type: 'pdf', page };
      } else if (sourceContext?.type === 'video') {
        const timestamp = Number(reference?.timestamp);
        const segment = sourceContext.segments.find(item => timestamp >= item.start && timestamp <= item.end);
        if (reference?.type !== 'video' || !Number.isFinite(timestamp) || !segment) throw invalidResponse();
        normalized.sourceRef = { type: 'video', timestamp };
      } else {
        if (reference !== undefined && reference !== null) throw invalidResponse();
        normalized.sourceRef = null;
      }
      return normalized;
    });
  }

  function normalizeGrade(output, questions, localVerdict) {
    if (!output || !Array.isArray(output.results) || output.results.length !== questions.length
      || typeof output.report !== 'string') throw invalidResponse();
    const byIndex = new Map();
    for (const result of output.results) {
      if (!result || !Number.isInteger(result.i) || result.i < 0 || result.i >= questions.length
        || byIndex.has(result.i) || !VERDICTS.has(result.verdict)
        || !CONFIDENCE.has(result.confidence)
        || typeof result.feedback !== 'string' || !result.feedback.trim()
        || (result.errorType !== null && result.errorType !== undefined && !ERROR_TYPES.has(result.errorType))) {
        throw invalidResponse();
      }
      byIndex.set(result.i, result);
    }

    return {
      results: questions.map((question, index) => {
        const result = byIndex.get(index);
        if (!result) throw invalidResponse();
        const objective = localVerdict(question, index);
        return {
          ...result,
          verdict: objective || result.verdict,
          errorType: objective === 'correct' ? null : result.errorType || null,
          confidence: objective ? 'high' : result.confidence
        };
      }),
      report: output.report.trim()
    };
  }

  return { normalizeQuestions, normalizeGrade };
});
