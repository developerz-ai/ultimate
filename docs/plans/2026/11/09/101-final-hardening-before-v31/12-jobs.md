# 12 — jobs: events never missed, relay and limits that scale

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 3 (`jobs`). The scaffold's default queue is [`17`](17-cli-runtime.md); job spans/semconv are [`20`](20-observability.md); store wiring is [`21`](21-adapter-wiring.md).

## Findings
| # | Sev | Site | Failure | Fix |
|---|---|---|---|---|
| J1 | **High** | `jobs/src/steps-wait.ts:53`, `driver-pg-sql.ts:263` (stamp), `:287` (`SQL_EVENT_FIND`) | an event published in a transaction is stamped at INSERT, visible at COMMIT. A `waitForEvent` whose first pass runs between them sets `startedAt` after the stamp; every later poll asks `published_at >= startedAt` and skips it. The run waits its full timeout (default 24 h) and gets `undefined`. The wiki says publish-in-transaction is supported | store `pg_current_xact_id()` on the event row; record `pg_current_snapshot()` at wait start; match `published_at >= floor OR NOT pg_visible_in_snapshot(e.xact, snap)`. Memory bus mirrors the rule |
| J2 | Low | `jobs/src/events.ts` (memory `find`), `driver-pg-sql.ts:287-299` | resume after a cursor event whose row was purged treats it as "no cursor"; same-millisecond events can be handed out again | carry `(publishedAt, id)` in the wait floor; one comparison rule in `steps-wait.ts` used by both buses |
| J3 | Med (perf) | `jobs/src/outbox-relay.ts` (`tick`) | a full batch (500) still waits the poll floor (200 ms): relay capped at 2,500 rows/s; a 100k backlog takes ≥ 40 s | `delayMs = 0` after a full batch, as `again` in `worker-loop.ts:97` |
| J4 | Med (perf) | `jobs/src/limits.ts` (`rateBlocked`; `starts.set(tenant, [...stamps, at])`) | per-tenant window copied and filtered on every acquire: 20k acquires = 3.9 s of event-loop time | per-tenant deque with a head index, compacted occasionally; `abandon` removes the last matching stamp |
| J5 | Low (perf) | `jobs/src/events.ts` (`publish` → `purgeExpired()`; `find` full scan) | memory bus scans every event on every publish (10k fill 916 ms) | purge on interval or over cap; per-name index |
| J6 | Low (perf) | `jobs/src/worker.ts` (`claimOne`) | registry sorted per claim; `claimed.slice(index + 1)` per job (O(batch²)) | cache the sorted names by registry version; pass `(claimed, index)` |
| J7 | Med (perf, prod) | `jobs/src/jobs-retention.ts:40-50` | retention batch averages 32–40 ms in production (`order by updated_at … for update skip locked` over `done`) | partial index `(updated_at) where state = 'done'` in the framework schema |
| J8 | Doc | `jobs/src/worker-fleet-slots.ts`, step runner | a slot holder that ignores `signal` runs past `concurrency`; a sync step longer than the 30 s visibility timeout starves the heartbeat → runs twice. Inherent to JS + at-least-once | state both in `wiki/Jobs.md` (at-least-once section) |

## Files to change
- `packages/jobs/src/steps-wait.ts`, `driver-pg-sql.ts` (event DDL + find), `events-pg.ts`, `events.ts`, `steps-store.ts` (floor shape) — J1, J2, J5.
- `packages/jobs/src/outbox-relay.ts` — J3. `limits.ts` — J4. `worker.ts` — J6. `jobs-retention.ts` + the framework jobs DDL — J7.
- `wiki/Jobs.md` — J8 and the J1 guarantee.

## Tests
- `events-tx-visibility.live.test.ts` (new, two sessions): A `BEGIN; publishEvent`; B first wait pass; A `COMMIT`; B resumes and hits.
- `events-cursor-parity.test.ts`: both buses, publish A then B in one ms, consume A, purge A, `find(afterId: A)` never returns A's predecessor.
- `outbox-relay.test.ts`: full batch → `pollDelayMs() === 0`; short → `intervalMs`.
- `limits.test.ts`: 20k acquires < 100 ms; existing cases unchanged.
- `bun test packages/jobs` · live suites in CI.

## Done when
- J1's two-session test is green on real Postgres; the relay drains a 100k backlog at batch speed.
