# 39 — `breaker()`: one state machine, the trigger stays the caller's

> Part of [`overview.md`](overview.md). Depends on: [`11-core-outbound.md`](11-core-outbound.md). Tier: 0 (`core`), adopters at 1 (`db`), 4 (`ai`).

## Why
Four repositories wrote the same state machine; `db/src/replica-client.ts:78-152` holds a private one. `ai/src/gateway.ts:339` re-spends `retry.attempts` plus backoff on every call to a provider that has been down for an hour, then does it again for the next call. Any team calling a vendor at load needs this.
Recorded objection: adopters agree on the machine and disagree on the trigger. Answer: that split is the API. The machine ships; `classify` and manual `failed()` are the trigger, so a trigger folding durable rows is the app's own call to `failed()` (axiom 8).

## Decisions
| Question | Answer |
|---|---|
| Does it replace the replica breaker? | yes. `parked()` becomes `state() === 'open'`, the routing check `admit()`, lines 128, 134, 141-142 the three record calls. Options and `BREAKER_FAILURES`, `BREAKER_COOLDOWN_MS`, `ReplicaStats`, `db.replica_fallback` unchanged |
| One behaviour change there | after the cooldown today every concurrent read tries the replica until one fails; now one probe does, the rest take the primary. A narrower blast on a replica still down. No existing assertion depends on the wider one; verify by running `replica-client*.test.ts` unchanged |
| Half-open | one probe. A probe that never settles lapses after `cooldownMs`, so a dead holder cannot wedge it |
| Fleet-wide state | no. Per process, stated. Each process learns in `failures` calls; a shared row would make the breaker depend on the thing most likely to be slow in an outage |
| `outbound()` | option `breaker`, the row [`11`](11-core-outbound.md) points here for. Recorded once per call, after 03's `retry()` finishes, so a retried-away 503 is not a failure |
| Gateway default | on, per provider: `{ failures: 5, cooldownMs: 30_000 }`; `breaker: 'off'` declines |
| Retry interaction | none in the executor. `retry()` stays one loop; the breaker sits outside it |

## Files to change
- `packages/core/src/breaker.ts` (new) — the machine. Injected `Clock`, monotonic only, as `replica-client.ts:99`.
- `packages/core/src/index.ts`, `core-error-codes.ts`, `error-retry.ts:33` — export, title, `retry-after` class.
- `packages/core/src/runtime-metrics.ts` — `breaker_transitions_total{name,to}`, one recorder, called only by `breaker.ts`.
- `packages/db/src/replica-client.ts:93-152` — drop the three `let`s and `parked()`; numeric screens stay here so a refusal still names `breakerFailures`.
- `packages/ai/src/gateway.ts:303` (`providerFor`), `:339-366` (`attempt`), `:94` config — skip an open provider, record per provider pass.
- `packages/core/src/outbound.ts` (from 11) — the option, classification table below.
- `wiki/Outbound-HTTP.md`, `wiki/MCP-And-AI.md` (gateway row), `docs/ops/03-observability.md:35`, `packages/core/CLAUDE.md` concept table, `packages/core/README.md`, `packages/db/CLAUDE.md` replicas paragraph, `packages/ai/CLAUDE.md` gateway rules. No `examples/dummy` use: a helper, not a primitive.

## Steps
1. `bun run new-error-code` below.
2. `breaker({ name, failures, cooldownMs, classify?, clock? })` returns `Breaker`: `admit(): boolean`, `succeeded()`, `failed()`, `released()`, `state(): 'closed' | 'open' | 'half-open'`, `failures(): number`, `run(fn)`. `name` is a bounded label chosen in code, never a tenant or a URL. `failures`, `cooldownMs` through `finiteCount`.
3. `admit()`: closed yes; open before the cooldown no; open past it moves to half-open and gives the one probe; half-open no until the probe settles or lapses. `state()` never consumes a probe.
4. `succeeded()` closes and zeroes. `failed()` in half-open reopens at once, else counts and opens at the limit. `released()` gives a probe back and counts nothing: a caller's abort says nothing about the vendor.
5. `run(fn)`: refuses `X_BREAKER_OPEN` when not admitted, `meta.retryAfterSeconds` from the time left. `classify(error)` answers `'failure' | 'success' | 'ignore'`; default: `declaredErrorRetry(code)` of `retryable` or `retry-after` is a failure, `X_ABORTED` and `X_DRAINING` ignore, the rest success (the dependency answered).
6. Replica: `nodeIsReplica` line 117 `return gate.admit()`, last, so only a statement about to reach the replica consumes a probe. Log field `consecutiveFailures: gate.failures()`.
7. Gateway: at `:339` a provider whose breaker refuses adds `<name>: breaker open` to `failures` and moves on, no sleep. A coded refusal (`:354`) and a non-retryable failure are `succeeded()`: the provider answered. `failed()` once after the attempts for that provider run out, so a down provider costs `attempts × failures` calls per cooldown, then none. All open: `AiProviderUnavailableError`, retryable, immediately. `stream` takes the first admitted provider in `providerFor` and records on first chunk or throw.
8. Outbound: `outbound({ …, breaker })`. Failure: `X_OUTBOUND_TIMEOUT`, `_UNREACHABLE`, `_UNAVAILABLE`, `_THROTTLED`. Success: the rest (`_REFUSED` means the vendor answered). A context abort: `released()`. A breaker's own `classify` wins.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_BREAKER_OPEN` (retry-after, 503) | `run()` or `outbound()` while open or a probe is out | wait `meta.retryAfterSeconds`; check the dependency `meta.name` names; raise `failures` or adjust `classify` if this outage is not one. `bun run new-error-code X_BREAKER_OPEN --package core --title '…' --cause '…' --fix '…' --status 503` |

## Tests
- `packages/core/src/breaker.test.ts` (unit, fake clock): transition table; one probe under concurrent `admit()`; lapsed probe re-admits; `released()` counts nothing; `state()` consumes nothing; `NaN` bounds refused; `run` classification.
- `packages/db/src/replica-client*.test.ts`: unchanged and green; new case for one probe after the cooldown.
- `packages/ai/src/gateway-breaker.test.ts` (unit): failing provider, 20 calls, `attempts: 3`, `failures: 5`: at most 15 provider calls and no sleeps past the fifth; second provider serves throughout; a 400 never opens. Fails on today's `attempt` (60 calls).
- `packages/core/src/outbound-breaker.test.ts` (unit): a 503 then 200 inside one call records success; caller abort records nothing.
- `bun test packages/core/src/breaker.test.ts`

## Semver
Minor. New export, code, option. Gateway default changes behaviour only after five consecutive transport failures; stated in `CHANGELOG.md` with `breaker: 'off'`.

## Done when
- `grep -n 'parkedUntil\|consecutiveFailures +=' packages/db/src/replica-client.ts` answers nothing.
- The gateway test's call count holds; `bun run scripts/reference-app-gate.ts` and `bun run verify` green.
