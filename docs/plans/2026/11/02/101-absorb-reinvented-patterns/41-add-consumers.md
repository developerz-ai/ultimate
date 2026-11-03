# 41 — `consumer()` and a backfill over a remote source

> Part of [`overview.md`](overview.md). Depends on: [`15-jobs-recipes.md`](15-jobs-recipes.md), [`33-ops-worker-roll.md`](33-ops-worker-roll.md) (`queue_demand`). Tier: 3 (`jobs`).

## Why
Reading a queue, a change stream or a vendor's cursor is what every integrated system does. 15 reproduced that a job expresses it, then killed `consumer()` although one adopter hand-rolled 530 LOC and another 830. That reasoning falls to the new bar:

- The recipe has a silent trap, reproduced in 15: a self-enqueue is deduped onto the running row, so a job re-arming itself never runs again.
- An agent must assemble keyed concurrency, an idempotency key, no timeout, a supervising `task`, drain handling, and a cursor committed with its batch. Forgetting one has no build error (axiom 3).
- `backfill()` cannot take a remote source: `source` returns a `ReadBuilder` (`jobs/src/backfill.ts:77`). And one pass per name (`:194`) cannot sweep per account.

A factory is the shape the framework already uses for this. `ROLES` stays closed. **This slice overrules 15's killed `consumer()` and `backfill.source`**; 15 itself still lands first, keeping its pins and wiki corrections, and writes no recipe prose.

## Decisions
| Question | Answer |
|---|---|
| Kinds | `consumer()` returns a `job` handle with a `.supervisor` `task`, both registered by `defineApi`. No new role |
| Cursor | a required seam: `load`, `save`. The webhook ledger's reasoning (`jobs/src/webhook-ledger.ts:1-8`): the app owns the row. `save` runs inside the batch's transaction, so cursor and effect commit together |
| Transports | none shipped. `open` is the app's async iterable. Any broker is the app's dependency at its own seam (`docs/idea/18-build-vs-wrap.md`) |
| Ordering, partitions | one running body per key. Parallelism is more keys |
| Backfill shape | widen `source`, not a second factory: `pages` beside `source`, exactly one |

## Files to change
- `packages/jobs/src/consumer.ts` (new) — factory.
- `packages/jobs/src/consumer-loop.ts` (new) — the turn: read, handle plus save in a transaction, heartbeat, drain check.
- `packages/core/src/registrar.ts:83` — `consumer`, `kind: 'job'`.
- `packages/jobs/src/backfill.ts:77,152,194` — `pages?`; `input?` with `scope`, so a ledger key is `name + scope(input)`.
- `packages/jobs/src/backfill-pass.ts` — walk a page function; the cursor checkpoint already exists (`:35`).
- `packages/jobs/src/backfill-ledger.ts` — `backfillChecksum` covers `pages`; a scoped key.
- `packages/jobs/src/backfill-registry.ts` — `x db backfill` lists a scoped pass per scope.
- `packages/cli/src/cmd-jobs.ts`, `jobs-json.ts` — a consumer row: key, last batch at, lag if declared.
- `packages/manifest/src/sources.ts` — `consumers`.
- `packages/jobs/src/recipes.job.test.ts` — 15's pins stay, as what the factory rests on.
- `wiki/Jobs-And-Workflows.md:162` — the factory's section, beside "One run per key"; `wiki/Migrations-And-Backfills.md`, `wiki/The-Eight-Primitives.md`, `packages/jobs/README.md`, `CLAUDE.md`, `wiki/Error-Codes.md`.
- `examples/dummy/apps/web/api/` — one `consumer` over the in-memory fake stream; one `backfill({ pages })` over a fake vendor.

## Steps
1. `consumer({ name, keys, open, handle, cursor: { load, save }, tenant, batch?, queue?, rearm?: '1m', lag? })`.
   - `keys({ ctx })` lists what should be running: often one, or one per account.
   - `open({ key, cursor, signal })` returns `AsyncIterable<Item>`.
   - `handle({ items, key, ctx, signal })` runs in a transaction, with `cursor.save(key, next)`.
2. Underneath: `concurrency: { key, limit: 1, whenBusy: 'wait' }`, `idempotencyKey: consumer:<name>:<key>`, no `timeout`, retry from `retry` with core's backoff. Exactly what 15's pins exercise, which now cannot be misassembled.
3. `.supervisor`: a `task` at `rearm` enqueuing each key. A no-op while live; a restart once not. So nothing self-enqueues, and 15's trap is unreachable. A `handle` calling its own `.enqueue` is refused: `X_CONSUMER_SELF_ENQUEUE`.
4. A body ending with the stream open returns normally; the next arm restarts it from the saved cursor. An upstream throw follows retry and dead-letter as any job does.
5. Drain: abort `signal`, and an attempt ended by drain is not counted (15's pin). The batch in hand either commits or rolls back; delivery is at least once, stated in docs, so `handle` must be idempotent per item. Item ids are the app's.
6. `lag({ key, cursor })`, optional: answers a number for a `queue_demand`-style gauge (33). Business meaning of a threshold stays the app's.
7. `backfill({ name, tenant, pages: async ({ ctx, cursor, signal, input }) => ({ rows, next }), handle, input?, scope? })`. `next: null` ends. Each page is a step, with rows not in the step's output: only `{ cursor, rows: n }`, as `backfill-pass.ts:58-71` already requires. `rate` paces the vendor. `count` is optional: a remote may not know.
8. `input` plus `scope(input)` makes one pass per scope: `sync-invoices` per account. Unscoped behaviour is byte-identical. A definition with `input` and no `scope` refused.

## Error codes
`bun run new-error-code` for each row.

| Code | When | Fix |
|---|---|---|
| `X_CONSUMER_INVALID` (off-socket) | missing `cursor`, or a `timeout` given | declare `cursor.load` and `cursor.save`; remove `timeout` |
| `X_CONSUMER_SELF_ENQUEUE` (off-socket) | a body enqueues its own consumer | delete it: `.supervisor` re-arms |
| `X_BACKFILL_SOURCE_INVALID` (off-socket) | both or neither of `source`, `pages`; `input` with no `scope` | keep one; add `scope` |

## Tests
- `packages/jobs/src/consumer.job.test.ts`, Postgres: batch and cursor commit together, proved by a throw in `save`; restart resumes after the last commit; a second arm is `deduped: true`; drain leaves the cursor on the last finished batch and does not count the attempt.
- `packages/jobs/src/consumer.test.ts`: self-enqueue refused; missing cursor refused.
- `packages/jobs/src/backfill-pages.job.test.ts`: killed mid-page resumes on that page; earlier pages not refetched; two scopes keep two ledgers; a changed `pages` changes the checksum.
- `packages/cli/src/cmd-jobs.test.ts`: the row's `--json`.
- `bun test packages/jobs/src/consumer.test.ts`

## Semver
minor. `PRIMITIVE_FACTORIES` rows are additive; existing `backfill()` unchanged.

## Done when
- `examples/dummy` declares one of each, and `x.manifest.json` lists them.
- `bun run verify`, `bun run scripts/reference-app-gate.ts` green.
