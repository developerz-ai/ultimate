# 39 — OTLP export survives a transient failure

> Part of [`overview.md`](overview.md). Depends on: [`03-core-lifetime-helpers.md`](03-core-lifetime-helpers.md) (the `retry()` it calls). Tier: 0 (`core`).

## Why
Traces are what an operator reads during an outage, and an outage is when a collector restarts. `postOtlp` (`core/src/otlp.ts:286-305`) sends once and warns. Reproduced, `otlpSpanExporter` with `maxBatchSize: 2`, first POST answers 503, 4 spans exported: printed `posts 2 spans delivered 2 of 4`. A rolling restart of a collector silently removes spans from every pod, on a surface no one tests until it matters. The OTLP/HTTP specification tells a client to retry these statuses.

## Decisions
| Question | Answer |
|---|---|
| What retries | 429, 502, 503, 504 and a transport failure: the specification's list. Not `isRetryableStatus` (`>= 500`, 408, 409, 425): a 500 or a 400 from a validating collector repeats forever, and core's table answers another question |
| Executor | core's `retry()` (`retry.ts:133`), `jitter: 'full'`, 3 attempts, 250 ms base, 5 s max. One executor, one curve; no loop here (`bun run flight-copies`) |
| `Retry-After` | honoured through `retryAfterSecondsOf` and `statedDelayMs`, under the budget |
| Budget | the existing `timeoutMs` (10 s) becomes the whole export, retries and waits included (`timeBudgetMs`); each attempt's signal is what remains. The pump's one batch in flight is therefore held no longer than today |
| Queue | unchanged. New spans wait in the queue while a batch retries, where drop-oldest applies (`otlp-span-exporter.ts:167`), so memory stays `maxQueueSize` plus one batch |
| Order | one batch in flight keeps parents before children across a retry |
| A duplicate | a collector that accepted then answered 503 receives the batch twice. Span ids dedupe at the backend; the specification accepts this |
| Metrics | same path. `otlp-metric-exporter.ts:141` holds the snapshot until settle; a retried batch is the same points |
| Drain | `shutdown()` in the `close` phase stays bound by the drain deadline (`settleWithin`). Abandoned means dropped with a line, as today |
| Never rejects | `postOtlp`'s contract holds: every path ends in a log line |

## Files to change
- `packages/core/src/otlp.ts:273-305` — `OtlpPostOptions` gains `sleep?`, `random?`, `now?`; the retry; a private retryable marker the policy classifies. `OTLP_RETRY_STATUSES`.
- `packages/core/src/otlp-span-exporter.ts:161`, `otlp-metric-exporter.ts:141` — nothing but the seams passed through from options.
- `packages/core/CLAUDE.md` (tracing section), `docs/ops/03-observability.md`, `CHANGELOG.md`. No `examples/dummy` use.

## Steps
1. Failing test first: the probe.
2. Wrap the fetch in `retry()`: a response in the table throws the marker carrying status and stated delay; any other response returns. Inside the wrap a thrown transport failure is retried, unless it is the budget's own abort.
3. After the last attempt: one `logger.warn('otlp export rejected' | 'otlp export failed')` with `attempts`, as today plus the count. One line per batch, not per try: a down collector must not flood logs.
4. `signal: AbortSignal.timeout(remaining)` per attempt; `NaN` remains impossible through `assertFiniteOtlpBound`.

## Error codes
None. Nothing crosses to a caller: `postOtlp` never rejects. The private marker is not a thrown `UltimateError` visible outside, and carries no code; it is an internal value class with a `why:` comment, exempt under the same rule as a suspension.

## Tests
- `packages/core/src/otlp-retry.test.ts` (unit, injected `fetch`, `sleep`, `random`): the probe delivers 4 of 4; 503, 503, 200 is 3 posts; 400 and 500 are 1 post; a `Retry-After: 2` waits 2 s by the injected sleep; budget exhausted stops early and logs one line; a throwing `fetch` retries; never rejects under each.
- `packages/core/src/otlp-backpressure.test.ts`: unchanged and green; add a retrying batch with `maxQueueSize` overflow, oldest dropped, held bytes bounded.
- `bun test packages/core/src/otlp-retry.test.ts`

## Semver
Minor. No API shape. A failed export can now take up to `timeoutMs` where it failed at once, and the same batch may arrive twice; both in `CHANGELOG.md`.

## Done when
- The probe prints `spans delivered 4 of 4`.
- `grep -n 'for (let attempt' packages/core/src/otlp.ts` answers nothing.
- `bun run verify` green.
