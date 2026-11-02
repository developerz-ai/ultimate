# 03 — Lifetimes in core: retry, joiners, close order

> Part of [`overview.md`](overview.md). Depends on: [`02`](02-db-entity-cancellation.md) (`runToCompletion`, for `retry()`'s way out). Tier: 0 (`core`), 1 (`cache`), 5 (`cli`).

## Why
Three reproduced defects, 2026-11-02:

| Probe | Printed |
|---|---|
| `retry(work, { attempts: 5 }, { sleep })` under a signal aborted at 5 ms, `work` calling `throwIfAborted()` | 5 attempts, 73 ms, signal already aborted. `X_ABORTED` is unclassified by design (`core/src/error-retry.ts:38-40`), so `classifyThrown` answers `undefined` and the loop goes on |
| `cacheStack` read: leader's load honours its signal, a joiner holds a live one, leader aborts | `leader-rejected:AbortError joiner-rejected:AbortError joiner signal aborted? false` |
| boot order: OTLP hook registered, then a worker `close` hook that ends a span; `drain()` | exported `[span-before-drain]`; `span-from-worker-teardown` is lost |

`retry()` knows no caller lifetime (`core/src/retry.ts:43-49,133`): after the budget it keeps sending to a vendor, holding its slot. No server caller in the tree today, only `client-flight.ts:242`, so this is the public helper's default that an app inherits.
A joiner shares the leader's promise (`core/src/single-flight.ts:106`), so one closed tab fails every healthy reader of a cold key: the arrivals `cache/src/tiers.ts:400` exists to collapse.
`serve-boot.ts:131` registers the exporter before `startRoles`, and `runPhase` runs registration order (`core/src/lifecycle.ts:283`), so the flush runs FIRST of the close phase, against what `cli/src/otlp-export.ts:32-34` says it is for.

## Decisions
| Question | Answer |
|---|---|
| Ambient or explicit | ambient by default, as `useContext()` everywhere else: a required `signal` is the argument an agent forgets |
| Page bytes | `client-flight.ts` must not import `context.ts`. The loop splits off into `retry-loop.ts`, and `client-flight` imports that |
| The clamp | `retry()` is the ONE place a loop meets the caller's lifetime: `outbound()` ([`11`](11-core-outbound.md)) reuses it and writes no second clamp |
| A retry that must outlive its caller | `runToCompletion(fn)` from [`02`](02-db-entity-cancellation.md): the one escape, so `retry()` has no opt-out of its own |
| A joiner after the leader's abort | its own signal live: re-lead, with its own `work`, under its own context. Its own signal dead, or the leader's signal live: the rejection propagates, ordinary failures included |
| How the flight sees a signal | injected, `SingleFlightOptions.signal: () => AbortSignal | undefined`: the flight layer reads no context, and `client-flight.ts:175` builds on this file. Absent means today's sharing |
| Classify `X_ABORTED` as terminal instead | no. A job body's `X_ABORTED` would dead-letter on attempt 1 |
| LIFO in which phases | `close` only. `accept` stays registration order: nothing there releases a resource. `inflight` has one hook |
| A new `flush` phase | no. Resources released in reverse of acquisition is one rule; a fourth phase is a second |

In-tree `close` registrations, audited for LIFO:

| Hook | Site | Depends on order? |
|---|---|---|
| `otlp-traces`, `otlp-metrics` | `cli/src/otlp-export.ts:57,71` | wants LAST: the fix |
| `http:<role>:close` | `http/src/server.ts:410` | no; one role per pod |
| `realtime:sync` | `realtime/src/sync-listen.ts:70` | no |
| `jobs.worker.<id>`, `jobs.outbox`, `jobs.scheduler` | `jobs/src/worker.ts:478`, `outbox-relay.ts:231`, `scheduler.ts:477` | relay now stops before the worker it follows; a row staged in that gap is durable and goes out on the next pod. Scheduler before relay, same |
| pool, `started` list | `cli/src/role-start.ts:349`, `hold.ts` release | after `drain()`, unaffected |

## Files to change
- `packages/core/src/retry-loop.ts` — new: `retryDecision`, the loop as `retryLoop`, types. No context import. Loop gains an internal `signal`: aborted before an attempt or after a failure ends it; aborted in the wait ends the wait at once; the LAST error reaches the caller unchanged, or the signal's reason when no attempt ran.
- `packages/core/src/retry.ts:133` — `retry(work, policy, deps?)` over `retryLoop`. Reads `tryUseContext()`: `signal` defaults to `ctx.signal`, budget to the smaller of `policy.timeBudgetMs` and `remainingBudgetMs(ctx)`. `sleep` defaults to an abortable timer. Inside `runToCompletion` the ambient signal is live and the deadline null, so nothing clamps.
- `packages/core/src/client-flight.ts:25,242` — imports `retryLoop`. Behaviour unchanged, its own `waitFor` stays.
- `packages/core/src/single-flight.ts:19,55,99-107` — the `signal` option; `Flight` holds the leader's, read at lead. A joined run with the option set: `running.catch`, and when the leader's signal is aborted and the joiner's is not, `run` again with the joiner's `work` and `join`. `settled` is attached first, so the key is already free; the first re-lead leads and the rest join it. No cap: each re-lead spends one aborted leader.
- `packages/cache/src/tiers.ts:275` — passes `signal: () => tryUseContext()?.signal`. `client-flight`, `render-isr` and `jwks` leave the option off: not measured here, and unchanged.
- `packages/core/src/lifecycle.ts:283` — `runPhase` reverses the filtered list when `phase === 'close'`.
- `packages/cli/src/serve-boot.ts:131` — `startOtlpExport` moves above `loadAppForRole` (`:114`), so an app's close hook registered at import also runs before the flush. It takes only `options.env`.
- `packages/cli/src/otlp-export.ts:33` — comment states the order it now relies on.
- Docs: `wiki/Resource-Management.md` "Bounded, not disposable", `wiki/Caching-And-Invalidation.md` (the stampede guard), `wiki/Deployment.md` shutdown phases, `wiki/Upgrading.md`; `packages/core/README.md`, `packages/core/CLAUDE.md` (flight row, lifecycle section), `packages/cache/CLAUDE.md`, `packages/cli/CLAUDE.md`.

## Steps
1. Split the loop; `page-bundle.test.ts` and action's and query's byte pins must not move.
2. `retry()` over it, ambient defaults. `RetryDeps` becomes optional as a whole: a widening.
3. Joiner re-lead in `single-flight.ts`, test first; cache adopts.
4. Reverse `close`. Registration stays an append; `shutdownHookCount` unchanged.
5. Move `startOtlpExport`; `acquired` already rolls it back on a failed boot.

## Error codes
| Code | When | Fix |
|---|---|---|
| none new | `retry()` rethrows the last error, or the signal's own coded reason | that error's |

## Tests
- `packages/core/src/retry-lifetime.test.ts`: the probe, now 1 attempt; abort during the wait ends it before the timer; spent budget takes no second attempt; inside `runToCompletion` under an aborted parent, all 5 run; outside any context, unchanged. Fails today on the first.
- `packages/core/src/single-flight.test.ts` extended, failing first: leader aborted + joiner live = joiner gets the value from a second load; three joiners = one second load; leader FAILS with its signal live = joiner gets that failure and no second load; joiner's own signal aborted = rejection propagates; no `signal` option = shares as today.
- `packages/cache/src/tiers.test.ts` extended: the probe, through `runWithContext` on two contexts. Fails today: `joiner-rejected:AbortError`.
- `packages/core/src/lifecycle-close-order.test.ts`: `close` hooks run in reverse, `accept` in order. Fails today.
- `packages/cli/src/otlp-export.test.ts` extended: a span ended by a close hook registered after the export is delivered. Fails today.
- `bun test packages/core/src packages/cache/src packages/cli/src/otlp-export.test.ts packages/cli/src/hold.test.ts`

## Semver
Minor for `retry()` (a stop on a dead caller; `deps` widened) and the joiner (an option; a rejection becomes a value). Close-hook order is observable: Upgrading entry, "close-phase `onShutdown` hooks run last-registered first; an app relying on the old order registers in the order it wants released". Lists under the same major as slice 02.

## Done when
- The `retry` probe prints 1 attempt, the cache probe prints `joiner:value`, the OTLP probe prints both spans.
- `page-bundle.test.ts` and the byte pins unchanged.
- `bun run verify` green.
