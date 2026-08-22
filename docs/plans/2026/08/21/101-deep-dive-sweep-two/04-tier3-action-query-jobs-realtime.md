# 04 — Tier 3: action, query, jobs, realtime

> Part of [`overview.md`](overview.md). Depends on: 01 (nothing hard). Tier: 3.

## Files to change
- `packages/realtime/src/index.ts:200-237` + `packages/realtime/package.json` — one `"."` export carries `useLive`/`liveHookFor`/`LiveClient` **and** `openNatsClient` (imports `nats`), `bunPgStream`, `PgReplicationStream`, `NatsTransport`. **Proven**: `bun build --target=browser` on an entry importing only `useLive` fails — *"Browser build cannot require() Node.js builtin: stream/web"* from `nats`. No `sideEffects` field. Deferred C8 from PR #116. An island calling `useLive` (what `wiki/Realtime.md` promises) cannot build.
- `packages/action/src/idempotency-postgres.ts:252` — `row.status as IdempotencyStatus`; an unknown status makes `withIdempotency` (`idempotency.ts:170-174`) return `{ value: null, replayed: true }`. `packages/jobs/src/driver-pg-rows.ts:64` (`statusIn`) is the rule written out.
- `packages/action/src/idempotency.ts:185` — `settle(key, value)` carries no reservation id; a straggler landing while the replacement reservation is in flight overwrites it. Deferred from PR #112; public signature → `12-decisions.md`. Plan the code here, land with the major.
- `packages/action/src/idempotency-postgres.ts:203` — `createdAt: Date.now()`; the memory store takes `now` (`idempotency-memory.ts:54`).
- `packages/action/src/sample-input.ts:80-87` — `sample[key]` / `properties[key]` without `Object.hasOwn`; siblings at `:40,:183` have it.
- `packages/action/src/http.ts:91` + `packages/query/src/http.ts:63` — `auth: policy.kind === 'allow' ? 'public' : 'required'` reads the root combinator only; `or(allow('public'), can(...))` is 401'd at `stages.ts:203` before `invoke`, while MCP/job surfaces allow it. Low; document or derive `auth` from "any branch admits anonymous".
- `packages/jobs/src/driver-pg.ts:106` — `pgStepStore.list` is `select *`, raw `timestamptz`, where every sibling statement projects epoch ms; a text-decoding `PgExecutor` yields `NaN` in `x jobs show`.
- `packages/jobs/src/worker-run.ts:71-99` — heartbeat started at `:71`; `createRunSignal` / `startRenewal` after it with no `try`. Latent; the acquire-list shape is `packages/cli/src/serve.ts:253`.
- `packages/realtime/src/offline-queue.ts:203,230,241` — `ack()` during a drain pass does not bump `#epoch` (`requeueInflight` does at `:191`), so the pass resends the acked mutation and `DrainReport.sent` over-reports.

## Steps
1. realtime: split `exports` into `"."` (client: `hooks`, `client`, `client-*`, `identity-map`, `live-rows`, `apply-patches`, `offline-queue`, `rebase`, `local-store`, `sync-protocol`, `json`, `cursor`) and `"./server"` (everything that touches `nats`, pg, `sync-node`, `sync-upgrade`, `sync-listen`, `replicator`, `changefeed`). Precedent: `packages/core/src/exports/`. Add `sideEffects` (array form; `bun run side-effects --explain --json` prints what the tree measures). Update every in-repo importer (`packages/cli/src/dev-sync.ts`, `packages/testing`, both apps). **Breaking** — `BREAKING —` row in CHANGELOG; the gate test is slice 09.
2. `isIdempotencyStatus` narrowing beside the type; refuse with a coded error in `rowToRecord`.
3. `settle(key, value, reservationId)` — fence on id AND state, copying `packages/jobs/src/driver-pg-sql.ts` `SQL_ACK`; memory store the same. Ships with the major.
4. Inject `now` into `postgresIdempotencyStore` options; default `Date.now`.
5. `Object.hasOwn` at `sample-input.ts:80-87`; build `sample` with `Object.create(null)` or `defineProperty`.
6. `SQL_STEP_LIST` in `driver-pg-sql.ts` with `SQL_STEP_GET`'s projection; call it from `list`.
7. `worker-run.ts`: wrap `createRunSignal` + `startRenewal` so a throw stops the heartbeat.
8. `offline-queue.ts`: `ack`/`fail` bump `#epoch`, or re-check `#mutations` membership at the top of each loop iteration beside the epoch check.
9. `http.ts` (action + query): derive `auth` from a policy walk (`anyBranchAllowsAnonymous(policy)`), or document the limitation in both `CLAUDE.md`s. Pick the walk if `policy` exposes its tree; otherwise document.

## Tests
- `packages/cli/src/realtime-browser-barrel.test.ts` (cli may import realtime) — `Bun.build({ entrypoints: [tmp importing useLive from '@ultimat3/realtime'], target: 'browser' })` succeeds; `@ultimat3/realtime/server` exports `openNatsClient`.
- `packages/action/src/idempotency-postgres.test.ts` — fake executor returning `status: 'archived'` → coded refusal, never `replayed: true`; straggler-vs-replacement case for step 3.
- `packages/jobs/src/driver-pg-sql.test.ts` — pin `SQL_STEP_LIST` text; `driver-pg.test.ts` — a text-decoding executor yields numeric `startedAt`.
- `packages/realtime/src/offline-queue.test.ts` — ack during a parked `send` → the acked mutation is not sent; `DrainReport.sent` equals frames on the wire.
- `packages/action/src/http.test.ts` — `or(allow('public'), can('x:y'))` → anonymous caller reaches `invoke` (if step 9 takes the walk).
- Command: `bun test packages/action packages/jobs/src/driver-pg-sql.test.ts packages/realtime/src/offline-queue.test.ts`.

## Done when
- The browser-barrel test fails on `main` and passes after; `bun run boundaries` green; both apps' `x verify` unchanged on the ratchet; CHANGELOG carries the `BREAKING —` rows for steps 1 and 3.
