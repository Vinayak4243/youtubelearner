# Gemini summary integration notes

Last checked: 2026-10-07.

- Model: Google documents `gemma-4-26b-a4b-it` as a Gemini API-hosted Gemma 4 model. It supports system instructions and a controllable thinking level. The summary pipeline uses system instructions and does not enable search grounding.
- Rate limits: intentionally not hard-coded. Google states that limits vary by model, project, and usage tier; inspect the active project in AI Studio before selecting production concurrency. The server retries `429` and transient `5xx` responses with jittered exponential backoff.
- Structured output: Google documents JSON schema support, while warning that only a schema subset is supported and complex/deep schemas may be rejected. `LLM_USE_NATIVE_SCHEMA=true` requests it, then automatically retries once without it on `400`; server validation remains mandatory.
- PDFs: unverified for this integration. This endpoint accepts transcript/source text only; extract PDF text server-side before calling it.
- Thinking: documented for Gemma 4 with `high` and `minimal` levels. The current REST client leaves it unset to reduce latency until measured on a golden set.
- Data-use terms: unverified for this project and plan. Product privacy copy must state the account-specific result before uploading learner transcripts in production.

Sources: [Gemma on Gemini API](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api), [structured outputs](https://ai.google.dev/gemini-api/docs/structured-output), and [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).
