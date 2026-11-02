# 35 — Concurrency fixes: replays, stale joins, quiet subscribers

> Part of [`overview.md`](overview.md). Depends on: K3 lands with or after [`03`](03-core-lifetime-helpers.md) (same flight), K6 with [`06`](06-jobs-step-semantics.md) (same file). Tier: 1 (`cache`), 2 (`auth`), 3 (`jobs`, `realtime`), 4 (`notify`).

## Why
Probed 2026-11-02 unless the row says read. K6 is the sharpest: `Promise.all` over completed steps re-runs one on replay and returns a value the store does not hold, so the at-least-once contract quietly becomes "run again".

## Fixes
| # | Sev | Site | Failure, as printed | Smallest fix | Failing-first test |
|---|---|---|---|---|---|
| K6 | High | `jobs/src/steps.ts:209-215` | `hydrated` assigned before `await store.list`, so a second caller reads the empty map. `Promise.all([run('a'), run('b')])` replayed: `[1, 20]`, stored `[1, 2]`, `bRuns: 2` | memoise the list PROMISE; `load` awaits it; `remember` writes after it. A rejected list clears the memo, so the next call retries | `jobs/src/steps.test.ts`: two completed steps in `Promise.all` on attempt 2, each body ran once, stored values back; a store whose `list` rejects once |
| K2 | High | `realtime/src/sync-node.ts:429`, `realtime/src/live-fanout.ts:121,239` | read, confirmed: `drain` calls `gapRepairs.repairAll` alone. `socket.desynced` has one reader, the next change's fanout. A query with no later change leaves that client stale for good, backpressure having cleared long ago | `drain` also re-snapshots each marked sid through `resnapshot` with `named: []`. Exposed as the fanout's `repair(socket)`. An entry whose window is not trusted stays marked, as `live-fanout.ts:108` says | `realtime/src/sync-drain.test.ts`: refused send marks the sid, `drain` with no change delivers one snapshot and clears; gate failure keeps the mark; second `drain` sends nothing |
| K7 | Med-high | `auth/src/jwks.ts:270` | key set unreachable, TTL passed: known `kid` refused `X_OAUTH_EXCHANGE_FAILED` ×5 with its key in memory; 6 fetches. 3 forged `kid`s: 9 fetches. Rated only on the not-stale path, so an IdP outage ends every login and each token costs a request | on a failed refresh, a known key answers from cache for `JWKS_STALE_IF_ERROR_MS` (1 h; past it, the refusal), logged `auth.jwks.stale_served`. `JWKS_FAILURE_COOLDOWN_MS` (30 s): no fetch inside it after a failure, either path. No option: both constants | `auth/src/jwks.test.ts`: frozen clock, outage, 5 calls with known `kid` answer and fetch once; forged `kid` in the cooldown refused, fetch count still 1; past 1 h refused; recovery after cooldown |
| K3 | Med | `cache/src/tiers.ts:400` | `drop('k')` during a load, then a read: leader `old`, read-after-bust `old`, next read `new`. The fence stops the fill, not the join. A read-your-write sees pre-write data for up to the load's life | a `leading` map of key to the flight's fence, set on lead. Before `flight.run`: fence invalid, `flight.evict(key)`, then lead. Same rule as `render/src/render-isr.ts:293`, and it covers tag busts, which name no key. `evict` is identity-safe (`core/src/single-flight.ts:76`) | `cache/src/single-flight.test.ts`: the probe, by key and by tag; a joiner before the bust still shares; no fence moved, one load |
| K4 | Med | `notify/src/ledger-pg.ts:46,55` | read; the audit's memory probe not re-run. Claim's `do update` fires for `status = 'sending'`, no owner, no lease, so a second attempt during the first sends too; settle matches by key alone, so a late attempt moves `sent` back to `failed` | as `SQL_IDEMPOTENCY_RESERVE` and `SETTLE` (`action/src/idempotency-postgres.ts:58,101`): `claim_id uuid` column added `if not exists`, claim fires only past a reclaim window, settle `and claim_id = $n`. **Moot if the owner deletes `notify`**: an architecture review proposes it; ask first, do not build | `notify/src/ledger-parity.live.test.ts`: two concurrent claims, one owner; late settle changes nothing; reclaim after the window |
| K5 | Low | `realtime/src/sync-frames.ts:75-77` | read: `teardown` ran during the awaited `heartbeat`, it answers false, `presence.join` runs for a closed socket. A ghost member until the TTL, on every other client's roster | after the roster: `if (socket.closed) await presence.leave(name, socket.id)`, return. Check after the await, not before: the race is the await | `realtime/src/sync-frames.test.ts`: close during a held `heartbeat`; roster has no member |

## Dropped here
| Finding | Reason |
|---|---|
| K1 plain statement has no acquire deadline | [`29-data-pg-unanswered.md`](29-data-pg-unanswered.md): `pool-gate.ts`, same probe |
| K1b idle in a transaction | [`29-data-pg-pooler.md`](29-data-pg-pooler.md): same URL, same `alter role` |

## Coordination
| Slice | Touches | How |
|---|---|---|
| [`03`](03-core-lifetime-helpers.md) | `single-flight.ts:99`, `tiers.ts:275` | K3 stays in `tiers.ts:400` and uses `evict`. A joiner re-leading after a leader's abort and a read refusing a dead flight are independent |
| [`06`](06-jobs-step-semantics.md) | `steps.ts:294-334` | K6 is `:209-221`. Same file, same sweep agent |
| [`11`](11-core-outbound.md) | `jwks.ts` adopts `outbound()` | K7 sits in `keyFor`, above the transport; land K7 first |
| [`35-fix-logic`](35-fix-logic.md) | L13 in `jwks.ts:202` | one agent |

## Files
`jobs/src/steps.ts`, `realtime/src/{sync-node,live-fanout,sync-frames}.ts`, `auth/src/jwks.ts`, `cache/src/tiers.ts`, `notify/src/ledger-pg.ts` if kept, tests beside each, `wiki/Upgrading.md`, `wiki/Caching-And-Invalidation.md`, `auth/README.md`.

## Error codes
None new. K7's past-window answer is the existing `X_OAUTH_EXCHANGE_FAILED`.

## Tests
`bun test packages/jobs/src/steps.test.ts packages/cache/src/single-flight.test.ts packages/auth/src/jwks.test.ts packages/realtime/src/sync-drain.test.ts`. `x test live` for K4.

## Semver
**Breaking only through K4; rest patch.** K4 adds a column to a framework table, so an app's committed `packages/db/schema/` reds `drift` (`X_SCHEMA_DUMP_DRIFT`). Upgrading: "`x db gen`, commit `packages/db/schema/`." Moot if the owner deletes `notify`; then the whole slice is patch.

## Done when
- The K6 and K3 probes print `[1, 2]`, runs 1, and read-after-bust `new`.
- An IdP outage leaves a known `kid` verifying for an hour, at one fetch per cooldown.
- A drained socket holds no desync mark with a trusted window.
- `bun run verify`, `bun run scripts/reference-app-gate.ts` green.
