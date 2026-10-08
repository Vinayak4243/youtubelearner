# Capacity plan: 10,000 concurrent learners

This application is designed to keep web, authentication, and data-sync requests stateless so Vercel Functions can scale them horizontally. Ten thousand simultaneous learners does **not** mean ten thousand simultaneous LLM calls: those calls are the constrained resource and must be admitted, queued, and metered.

## Request classes

| Traffic | Runtime path | Capacity policy |
| --- | --- | --- |
| Static application assets | Vercel CDN | Cached globally |
| Authentication and snapshots | Express Function + Supabase RLS | Stateless, connection-pooled, per-user isolation |
| Video metadata | Express Function + YouTube API | Server key only, strict timeout and quota-aware failures |
| AI text, JSON, streams, summaries | Express Function + Gemini | Authenticated, per-user database quota and bounded per-instance admission |
| Long transcript summaries | Durable queue consumer | Async job, idempotency key, partial results persisted per user |

## Already enforced in this repository

- Authentication and learner data use the verified Supabase user id; browser-supplied ids are ignored.
- API request bodies are capped at 4 MB, under Vercel's request-body limit.
- AI routes have an account-level persistent rate-limit hook and an in-memory per-instance admission gate. When the gate is full, the API returns `429 ai_capacity_busy` with `Retry-After` rather than exhausting Function or provider capacity.
- Provider calls have timeouts, bounded retries, and safe error messages. Full transcripts and learner answers are not logged.

## Required production rollout before a 10k launch

1. **Vercel plan and observability.** Use a plan with enough concurrent Functions and Fluid Compute capacity. Set function-region placement close to Supabase, enable request/error monitoring, and alert on Function errors, `429`, `5xx`, and p95 latency.
2. **Supabase.** Use a production tier with a serverless connection pool. Apply all snapshot and `consume_user_ai_rate_limit` migrations; do not accept the per-instance fallback as production capacity control. Keep RLS enabled for every learner table.
3. **Distributed AI admission.** Provision Redis/Upstash or Vercel Queues. A process-local gate protects one warm Function only; global quotas must be enforced by an atomic shared counter or queue.
4. **Durable summary queue.** Send jobs with an idempotency key based on `user_id + video_id + transcript_hash + prompt_version`. Store only the minimum encrypted source reference/job state in Supabase or Blob, not raw learner answers. Consumers must be idempotent because queue delivery is at least once. Return `202 { jobId }`, expose `GET /api/summary/:jobId`, and let clients poll with exponential backoff.
5. **AI provider capacity.** Obtain Gemini quotas that cover the planned requests-per-minute and tokens-per-minute. Start with conservative per-user budgets, measure real token usage, and use a circuit breaker when the provider returns repeated `429`/`5xx` responses.
6. **Load test before launch.** Use a production-like environment, synthetic accounts, and a staged ramp (100, 1,000, then 10,000 connected learners). Verify error rate, p95/p99 latency, database saturation, queue age, and provider quota headroom. Do not load test production with real learner data.

## Operational SLOs

- Static/UI availability: 99.9% monthly.
- Authentication/snapshot API: p95 under 500 ms excluding Supabase outages.
- AI requests: queued or rejected quickly; never let unbounded work create a cascading outage.
- Queue age: alert at 60 seconds; shed new low-priority jobs before queued work exceeds the user-facing target.

## Configuration

`AI_MAX_IN_FLIGHT_PER_INSTANCE=1`, `AI_REQUESTS_PER_MINUTE=4`, and `AI_ADMISSION_WAIT_MS=1000` are conservative free-tier defaults, not universal limits. Adjust them only after observing Function CPU/memory, Gemini latency, and quota consumption. Gemini `429` retries wait 15 seconds by default (`GEMINI_RETRY_DELAY_MS`) and occur once (`GEMINI_RATE_LIMIT_RETRIES`).
