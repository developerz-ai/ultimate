# 02 — schema and core: the per-request floor, and errors an operator can read

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0.

Every request and every validated value pays these. All measured in-process 2026-11-11 (30k requests, CPU profile); each fix is pinned by a work count, never by wall time (pattern: `packages/schema/src/standard.large.test.ts`).

## Findings

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| S1 | P2 | confirmed (measured) | `packages/schema/src/builder.ts:333` (`checkOf`), `:249` (`capped`); `array-schema.ts:86`; `validators.ts:227` | Each member of a composite is validated through the public `'~standard'.validate`: a `withIssueCap` closure, a `CappedRun`, a `StandardResult`, a `pass()` re-wrap and a fresh path array, even when it passes. 81 ns for one `t.number`, 187 ns per array item, 4.6 µs for a 5-field object: 47 ms of synchronous CPU per 10k objects | a `WeakMap<Schema, Check>` filled in `makeSchema`; builtin members call the internal `Check`, `checkOf`'s public route stays for foreign Standard Schema members only. Path built lazily from `(parentPath, key)` on failure. Issue order and the cap unchanged |
| C1 | P1 | confirmed (read) | `packages/core/src/error-reporter-sentry.ts:136` (`exception.values[0]` = type + value), `:134` (stack as a string in `extra`) | No `stacktrace`: every production issue has zero frames | `sentry-frames.ts` (new): parse `report.stack` (V8 `at fn (file:line:col)`) into `stacktrace.frames`, oldest first, `in_app` false for `node_modules` and `@ultimat3/`. Never throws. `extra.stack` stays one release |
| C2 | P1 | confirmed (read) | `packages/core/src/error-fingerprint.ts:86-95`, used at `error-reporter-sentry.ts:110` | The default fingerprint hashes `code + source + scope.operation`: one code raised from five operations is five issues (seen in production) | `[code]` for a classified code; the application frame only for `X_INTERNAL`. `source` and `operation` stay tags / `transaction`. A grouping change: one `wiki/Upgrading.md` entry |
| C3 | P2 | gap (one adopter, 301-line wrapper) | `packages/core/src/error-reporter-sentry.ts` (`sentryTransport()` seam, `SentryReporterHooks.fingerprint`) | Scrub, drop-by-code and fingerprint need a wrapper around the transport | options on the one reporter: `sentryErrorReporter({ scrub, drop, fingerprint })`; the hooks object stays the only seam (no second path: fold `SentryReporterHooks` into the options, keep the old name as a type alias) |
| C4 | P3 | confirmed (measured) | `packages/core/src/logger.ts:408-417` (`resolveLevel`), `:472` (`child`) | `ctxOf` calls `rootLogger.child()` per request; `child` rebuilds a logger and `resolveLevel` renders its refusal message (a `JSON.stringify`) even for a valid level: 1.5 µs per request | `child` passes the validated level through a private path; the message is built only on refusal |
| C5 | P3 | confirmed (measured) | `packages/core/src/logger.ts:156-159` (`isRedactedKey`), `:305` (`redactFields`) | Every key of every line is lower-cased and run through `CREDENTIAL_NAME`: 249 ns per key, 2.2 µs per 9-field line, again over `bound` and `contextFields()` on every emit | verdict memoised per key in a bounded `Map` (4,096); `bound` redacted once in `child` |
| C6 | P3 | confirmed (profile) | `packages/core/src/metric-series.ts:32-38` (`seriesKey`); `runtime-metrics.ts:71-79` | `recordRequest` hands one attribute object to two instruments; each builds its key with entries + sort + `JSON.stringify` | compute once: `seriesForKey(instrument, key, attributes)`; cache per `(method, route, class)` |
| C7 | P3 | plausible | `packages/core/src/visible-interval.ts:55-56,73-76` (behind `pollEvery`, `packages/realtime/src/query-poll.ts:17`) | Failure back-off only when `maxMs` is passed; default `max = base`, so every open tab polls a failing endpoint at full rate | default `maxMs = 8 × ms`, jittered; a healthy period stays exact |
| C8 | P2 | gap (three adopters hand-rolled it) | `packages/core/src/index.ts` (absent) | No bounded concurrent map with a deadline | `mapBounded(items, fn, { width, signal })` in `core`: results in input order, first rejection aborts the rest through the signal, `width` required (no default: the caller states it). Guard in [`13`](13-cli-exercise-verify.md) |
| C10 | P3 | absent (catalogue) | `packages/core/src/outbound.ts:1`, `breaker.ts:1`, `retry.ts:1` | Attempts are clamped per call; nothing limits retries as a share of calls per breaker key (fleet amplification during a partial outage) | a token ratio per breaker key (retries ≤ 20% of calls); the refusal is the existing breaker-open code |
| C9 | P3 | plausible (not measured) | `packages/core/src/image/png-pixels.ts:59,145` (`Bun.deflateSync`, `inflateRawSync`) | The PNG raster path inflates and deflates on the event loop, up to `MAX_IMAGE_PIXELS` (64 MP) | measure first (4096² crop vs a 1 ms timer). If it blocks > 50 ms: run raster work in a `Worker` owned by `core/src/image/`; the web role refuses a synchronous raster crop above a pixel budget with a coded error naming `image-warm.ts`'s job |

## Files to change
- `packages/schema/src/builder.ts`, `array-schema.ts`, `validators.ts`, `record-schema.ts`, `discriminated-union.ts` — S1.
- `packages/core/src/error-reporter-sentry.ts`, `sentry-frames.ts` (new), `error-fingerprint.ts` — C1, C2, C3.
- `packages/core/src/logger.ts` — C4, C5 (at 475+ lines: split `logger-redact.ts` out first; the `filesize` step).
- `packages/core/src/metric-series.ts`, `metrics.ts`, `runtime-metrics.ts` — C6.
- `packages/core/src/visible-interval.ts` — C7. `packages/core/src/retry.ts`, `breaker.ts` — C10.
- `packages/core/src/map-bounded.ts` (new), `index.ts` — C8. `packages/core/README.md`, `CLAUDE.md`.
- `packages/core/src/image/png-pixels.ts`, `image/raster-worker.ts` (new, only if measured) — C9.
- Coordinator only: `wiki/Upgrading.md` + changelog (C2, C7), `wiki/Error-Codes.md` via `bun run new-error-code` (C9, if it ships), `bun run manifest`.

## Steps
1. S1 first, alone in `schema/`: write the work-count pin, then the `WeakMap` route. Run every schema suite; the issue order must not move.
2. C1/C2/C3 one worker: frames, then fingerprint, then options. Verify against a real ingest: send one event to the error tracker's test project and read it back with the infrastructure repo's read-only issue report ([`30`](30-infra.md)); frames present, one issue per code.
3. C4/C5/C6 one worker in `logger.ts` + metrics. Re-run the in-process hello bench ([`06`](06-http.md) H1) before and after; record µs.
4. C7, C8: small, one worker. C9: measure, then decide; record the number either way.

## Tests
- `packages/schema/src/standard.perf.test.ts` — allocations/checks per item for 10k valid objects, pinned.
- `packages/core/src/error-reporter-sentry.test.ts` — frames in Sentry's order; garbage stack → no frames, no throw; same code from two operations → one fingerprint; `X_INTERNAL` from two frames → two; `scrub`/`drop` applied.
- `packages/core/src/logger.test.ts` — `child()` never calls `renderCauseValue` (spy); the redaction regex runs once per distinct key; verdicts unchanged.
- `packages/core/src/metric-series.test.ts` — one `JSON.stringify` per `recordRequest`.
- `packages/core/src/visible-interval.test.ts` — three failures stretch the waits; a success resets.
- `packages/core/src/map-bounded.test.ts` — max in flight ≤ `width`; order kept; abort stops the rest.
- Command: `bun test ./packages/core/src/<file>.test.ts`.

## Done when
- A 5-field object validates in under half the measured 4.6 µs (work count pinned).
- An error-tracker issue from the demo carries frames; one code is one issue.
- `ctxOf` + one request log line cost measurably less (bench row recorded in the PR).
- `mapBounded` exported, documented, used by `notify` fan-out in [`12`](12-notify-ai-mcp-pwa.md).
