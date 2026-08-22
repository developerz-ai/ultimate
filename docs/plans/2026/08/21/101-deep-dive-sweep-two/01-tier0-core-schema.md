# 01 — Tier 0: core, schema

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0.

## Files to change
- `packages/core/src/lifecycle.ts:333-337` — `drainPromise` is assigned after the IIFE body has already run `runPhase('accept')` synchronously (`lifecycle-deadline.ts:35` `settleWithin` invokes `work()` sync). An accept hook that calls `drain()` — or `handle.stop()`, which is `packages/http/src/server.ts:213` → `drain('manual')` — re-enters with the memo still `undefined`. **Proven**: 9,400+ invocations per hook before stack exhaustion, each level swallowed by `settleWithin` as `shutdown hook failed`.
- `packages/core/src/lifecycle.ts:148` — `registerReadinessCheck` has zero callers outside core (the wiring lands in slice 07). Here: expose the count — see step 3.
- `packages/core/src/telemetry.ts:176` — `currentSpanContext()` synthesises a parent `{ traceId, spanId: '', traceFlags: 1 }`, so `startSpan` treats a request context as a sampled upstream decision and never calls `currentSampler()`. **Proven**: `parentBasedRatioSampler(0)` inside `runWithContext` exports 1 span; outside, 0. `packages/http/src/pipeline.ts:248-249` is `runWithContext` then `withSpan`, so every HTTP root span is exported regardless of ratio.
- `packages/core/src/otlp.ts:128` — `decodeURIComponent` on `OTEL_EXPORTER_OTLP_HEADERS` throws a bare `URIError` on `%zz`. **Proven.**
- `packages/core/src/context.ts:73,184` — `CtxPatch = Omit<CtxInit, 'requestId'>` leaves `buildId` patchable; `withChildContext({ buildId })` silently keeps the parent's. **Proven.**
- `packages/core/src/decimal-order.ts:51` — sign compared before magnitude: `compareDecimalText('-0', '0')` is `-1`; Postgres `numeric` says `0`. Low reach.
- `packages/core/src/registrar.ts` — add `PRIMITIVE_FACTORIES` beside `PRIMITIVE_KINDS` (step 6).
- `packages/schema/src/errors.ts:104` — `SchemaError.message` is `code: title`; `UltimateError` (`packages/core/src/errors.ts:84-89`) is `code: title — cause`, and the comment there says why the cause must be in the one field an uncaught escape prints. **Proven.**
- `packages/schema/src/describe-value.ts:28` and its deliberate twin `packages/core/src/error-render.ts:255-258` — string length via `.length` (UTF-16 units) while `validators.ts:64-77` counts code points. `t.string.min(3).safeParse('👍a')` → *"at least 3 chars, received a string of 3 characters"*. **Proven.** Both copies in one commit; `packages/cli`'s pin test holds them equal.

## Steps
1. `drain()`: create the memo before any hook can run — assign `drainPromise` to a deferred promise (or hoist the assignment above `runPhase`) so a re-entrant `drain()` returns the in-flight promise. The rule is already written at `packages/jobs/src/worker.ts:303-315`: guard and registration in one synchronous step.
2. `startSpan`: when `parent.spanId === ''` (the discriminator `end()` at `telemetry.ts:248` already uses to drop a synthetic `parentSpanId`), treat it as *no inbound decision* and run `currentSampler().shouldSample(...)`; carry only the trace id from the context.
3. `readyzPayload()`: add a `registered: number` field to `HealthReport` so slice 07's wiring and a future gate check can assert a process registered at least one check. Do not make an empty registry fail `/readyz` — that reds every scaffolded app before slice 07 lands.
4. `otlpHeaders`: refuse with `X_OTLP_ENDPOINT_INVALID` naming `OTEL_EXPORTER_OTLP_HEADERS` (an operator-set var with a bad escape is a misconfiguration, not a value to keep raw); the `try/catch` shape is `packages/storage/src/signed-url.ts:288-294`.
5. `CtxPatch = Omit<CtxInit, 'requestId' | 'buildId'>` with the one-line reason beside the existing one (a child context is the same deploy). Pin in `packages/core/src/type-pins.ts`.
6. `PRIMITIVE_FACTORIES` in `registrar.ts`: `Object.freeze<readonly { factory: string; pkg: string; kind: PrimitiveKind }[]>` listing `llm`/`agent`/`hive` (`ai` → `action`), `agentJob`/`backfill`/`scrape` (→ `job`). Delete the ordinal sentences at `packages/ai/src/hive.ts:4` and `packages/scraping/src/scrape.ts:1-2` and the two-example list in root `CLAUDE.md`'s primitives section; the pin test is slice 09.
7. `SchemaError`: `super(\`${code}: ${title} — ${cause}\`, { cause })`.
8. `describeValue` string branch: count code points the way `charCount` does; same edit in `error-render.ts`.
9. `compareDecimalText`: compute magnitude first; return `0` when both are zero before the sign branch.

## Tests
- `packages/core/src/lifecycle.test.ts` — a synchronous `{ phase: 'accept' }` hook whose body calls `drain()`; `await drain('SIGTERM')`; each hook ran exactly once.
- `packages/core/src/telemetry.test.ts` — `parentBasedRatioSampler(0)` inside `runWithContext(createContext({}), …)` exports 0 spans; ratio 1 exports 1 with `parentSpanId: undefined`.
- `packages/core/src/otlp.test.ts` — `OTEL_EXPORTER_OTLP_HEADERS=a=%zz` → coded error, not `URIError`.
- `packages/core/src/type-pins.ts` — `buildId` is not a key of `CtxPatch`.
- `packages/core/src/decimal-order.test.ts` — `'-0'` vs `'0'` and `'-0.00'` vs `'0'` → `0`.
- `packages/core/src/registrar.test.ts` — `PRIMITIVE_FACTORIES` has six rows, every `kind` in `PRIMITIVE_KINDS`.
- `packages/schema/src/errors.test.ts` — `.message` contains the cause.
- `packages/schema/src/describe-value.test.ts` — `describeValue('👍')` → `a string of 1 character`; `t.string.min(3).safeParse('👍a')` message quotes `2 characters`.
- Command: `bun test packages/core/src/lifecycle.test.ts packages/core/src/telemetry.test.ts packages/schema/src`.

## Done when
- All tests above fail on `main` and pass after; `bun run typecheck` green; the `error-render` / `single-line` cross-package pins in `packages/cli` still pass.
