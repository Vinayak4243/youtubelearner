(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AdaptPracticeLearningValidation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const QUESTION_TYPE_ALIASES = {
    multi_select:'multi',
    true_false:'tf',
    fill_blank:'short',
    numerical:'numeric',
    coding:'code'
  };
  const QUESTION_TYPES = new Set([
    'mcq', 'multi', 'tf', 'short', 'long', 'numeric', 'case_based',
    'assertion_reason', 'dry_run', 'debugging', 'code', 'scenario', 'interview'
  ]);
  const GROUNDING = new Set(['source_derived', 'external', 'ai_generated']);
  const BLOOM = new Set(['recall', 'understand', 'apply', 'analyze', 'transfer']);
  const VERDICTS = new Set(['correct', 'partial', 'incorrect']);
  const CONFIDENCE = new Set(['low', 'medium', 'high']);
  const ERROR_TYPES = new Set([
    'conceptual', 'application', 'calculation', 'logical', 'logical reasoning', 'recall',
    'misreading', 'syntax', 'implementation', 'edge_case', 'edge case', 'careless',
    'partial_understanding', 'incomplete', 'other'
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

  function normalizeType(value) {
    const raw = String(value || '').toLowerCase().trim();
    return QUESTION_TYPE_ALIASES[raw] || raw;
  }

  function normalizeDifficulty(value) {
    if (Number.isInteger(value) && value >= 1 && value <= 5) return value;
    const text = String(value || '').toLowerCase().trim();
    if (/^[1-5]$/.test(text)) return Number(text);
    if (['easy', 'medium', 'hard'].includes(text)) return text;
    return 'medium';
  }

  function normalizeHints(question) {
    const hints = Array.isArray(question.hints) ? question.hints : question.hint !== undefined ? [question.hint] : [];
    if (hints.some(hint => typeof hint !== 'string' || !hint.trim())) throw invalidResponse();
    return hints.map(hint => hint.trim()).slice(0, 3);
  }

  function normalizeOptions(options) {
    if (!Array.isArray(options) || options.length < 2 || options.length > 8) throw invalidResponse();
    return options.map(option => {
      if (typeof option === 'string') return option.trim();
      if (option && typeof option === 'object' && typeof option.text === 'string') return option.text.trim();
      throw invalidResponse();
    });
  }

  function normalizeErrorTag(value) {
    if (value === null || value === undefined || value === '') return null;
    const raw = String(value).toLowerCase().trim();
    const normalized = raw.replace(/\s+/g, '_');
    if (ERROR_TYPES.has(normalized)) return normalized;
    if (ERROR_TYPES.has(raw)) return raw;
    throw invalidResponse();
  }

  function referenceFromQuestion(question) {
    if (question.sourceRef !== undefined) return question.sourceRef;
    const source = question.source;
    if (!source || typeof source !== 'object') return undefined;
    if (source.page !== undefined) return { type:'pdf', page:source.page };
    if (source.video_id || source.timestamp !== undefined || source.start !== undefined) {
      const raw = source.timestamp ?? source.start;
      if (typeof raw === 'string' && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) {
        const parts = raw.split(':').map(Number);
        const timestamp = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
        return { type:'video', timestamp };
      }
      return { type:'video', timestamp:raw };
    }
    return undefined;
  }

  function normalizeQuestions(output, fallbackConcept, sourceContext) {
    if (!output || !Array.isArray(output.questions) || !output.questions.length || output.questions.length > 30) {
      throw invalidResponse();
    }
    return output.questions.map(question => {
      const text = typeof question?.text === 'string' ? question.text : question?.stem;
      const solution = Array.isArray(question?.solution_steps)
        ? question.solution_steps.map(String).filter(Boolean).join('\n')
        : question?.explanation;
      const why = typeof question?.why === 'string' ? question.why : question?.why_generated;
      if (!question || typeof text !== 'string' || !text.trim()
        || typeof solution !== 'string' || !solution.trim()
        || typeof why !== 'string' || !why.trim()) throw invalidResponse();

      const type = normalizeType(question.type);
      if (!QUESTION_TYPES.has(type)) throw invalidResponse();
      const hints = normalizeHints(question);
      const grounding = question.grounding === undefined || question.grounding === null
        ? (sourceContext ? 'source_derived' : 'ai_generated')
        : String(question.grounding).trim();
      if (!GROUNDING.has(grounding)) throw invalidResponse();
      const normalized = {
        ...question,
        type,
        id: typeof question.id === 'string' && question.id.trim() ? question.id.trim() : undefined,
        text: text.trim(),
        explanation: solution.trim(),
        why: why.trim(),
        concept: typeof question.concept === 'string' && question.concept.trim()
          ? question.concept.trim()
          : typeof question.concept_id === 'string' && question.concept_id.trim()
            ? question.concept_id.trim()
            : String(fallbackConcept || 'General'),
        difficulty: normalizeDifficulty(question.difficulty),
        bloom: BLOOM.has(String(question.bloom || '').toLowerCase()) ? String(question.bloom).toLowerCase() : undefined,
        marks: Number.isFinite(Number(question.marks)) ? Number(question.marks) : undefined,
        grounding,
        hints,
        hint: hints[0] || (typeof question.hint === 'string' ? question.hint.trim() : undefined)
      };
      if (question.tolerance !== undefined) {
        const tolerance = Number(question.tolerance);
        if (!Number.isFinite(tolerance) || tolerance < 0) throw invalidResponse();
        normalized.tolerance = tolerance;
      }

      if (type === 'tf') {
        const answer = question.answer;
        if (answer === 0 || answer === true || /^(true|yes|t)$/i.test(String(answer))) normalized.answer = 0;
        else if (answer === 1 || answer === false || /^(false|no|f)$/i.test(String(answer))) normalized.answer = 1;
        else throw invalidResponse();
        normalized.options = ['True', 'False'];
      } else if (type === 'mcq' || type === 'multi') {
        normalized.options = normalizeOptions(question.options);
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
      if (question.distractor_rationale !== undefined && (typeof question.distractor_rationale !== 'object' || Array.isArray(question.distractor_rationale))) throw invalidResponse();
      if (question.error_tags_if_wrong !== undefined) {
        if (typeof question.error_tags_if_wrong !== 'object' || Array.isArray(question.error_tags_if_wrong)) throw invalidResponse();
        normalized.error_tags_if_wrong = {};
        for (const [key, value] of Object.entries(question.error_tags_if_wrong)) {
          normalized.error_tags_if_wrong[key] = normalizeErrorTag(value);
        }
      }
      const reference = referenceFromQuestion(question);
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
      if (normalized.sourceRef === null && normalized.grounding === 'source_derived') normalized.grounding = 'ai_generated';
      return normalized;
    });
  }

  function normalizeSummary(output) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw invalidResponse();
    const topics = Array.isArray(output.topics) ? output.topics.map(topic => {
      if (!topic || typeof topic !== 'object' || Array.isArray(topic) || typeof topic.name !== 'string' || !topic.name.trim()) throw invalidResponse();
      const grounding = topic.grounding === undefined ? 'source_derived' : String(topic.grounding).trim();
      if (!GROUNDING.has(grounding)) throw invalidResponse();
      return {
        name:topic.name.trim(),
        definition: typeof topic.definition === 'string' ? topic.definition.trim() : '',
        key_points: Array.isArray(topic.key_points) ? topic.key_points.map(String).filter(Boolean).slice(0, 8) : [],
        formulas: Array.isArray(topic.formulas) ? topic.formulas.map(String).filter(Boolean).slice(0, 5) : [],
        example: typeof topic.example === 'string' ? topic.example.trim() : '',
        commonly_confused: Array.isArray(topic.commonly_confused) ? topic.commonly_confused.slice(0, 5) : [],
        goal_relevance: topic.goal_relevance && typeof topic.goal_relevance === 'object' ? topic.goal_relevance : null,
        review_at: topic.review_at === undefined || topic.review_at === null ? null : String(topic.review_at),
        grounding
      };
    }) : [];
    if (!topics.length) throw invalidResponse();
    const quick_revision = Array.isArray(output.quick_revision)
      ? output.quick_revision.map(String).filter(Boolean).slice(0, 5)
      : [];
    return {
      chapter: output.chapter && typeof output.chapter === 'object' ? output.chapter : null,
      topics,
      quick_revision,
      not_covered_in_source: Array.isArray(output.not_covered_in_source) ? output.not_covered_in_source.map(String).filter(Boolean) : []
    };
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
        || (result.errorType !== null && result.errorType !== undefined && !ERROR_TYPES.has(String(result.errorType).toLowerCase().trim().replace(/\s+/g, '_')) && !ERROR_TYPES.has(result.errorType))) {
        throw invalidResponse();
      }
      const errorType = normalizeErrorTag(result.errorType);
      byIndex.set(result.i, result);
      result.errorType = errorType;
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

  return { normalizeQuestions, normalizeGrade, normalizeSummary };
});
