# 04 — Missing tests + gate visibility

> Part of [`overview.md`](overview.md). Depends on: none (01/02 fix the bugs these tests would have caught). Tiers: all.

Rule: tests next to source as `<file>.test.ts`; a test that can't fail isn't a test. Suffixes gate
the opt-in suites (`packages/cli/src/verify-tests.ts:34-55`).

## The gate hides its own skips

- `x verify` counts steps, not skips (`packages/cli/src/cmd-verify.ts:250-253`); a non-applying suite records `{ ok: true, skipped: true }` (`:226-229`) and live suites `describe.skipIf` to zero assertions without `TEST_DATABASE_URL`/`TEST_NATS_URL`/`TEST_REPLICATION_URL`. Today "17/17 green" is compatible with `contract`/`job`/`eval` never existing (counts: contract 1 file, live 9, job 0, e2e 1, eval 0).
- Fix: summary line shows `N passed, M skipped (contract, job, eval)`; `--json` already carries the fact. Optionally a `budgets`-style floor: suites that once applied must keep applying (ratchet, like `scripts/reference-app-gate.ts`).

## Uncovered clusters, priority order

| Priority | Package | Files (all exports untested) | Why first |
|---|---|---|---|
| 1 | `policy` | `evaluate.ts`, `permissions.ts`, `roles.ts`, `define.ts` | the entire authorization decision path |
| 1 | `entity` | `pg-sql.ts` (every statement builder), `plan.ts` (the layer both drivers share) | exactly the drift the two-driver split exists to prevent; prerequisite confidence for [`07-batching.md`](07-batching.md) |
| 1 | `auth` | `tokens.ts` (incl. `timingSafeEqual`), `verify.ts` (password reset!), `guards.ts`, `policy-bridge.ts`, `memory-adapter.ts` | secret primitives and the identity funnel |
| 2 | `schema` | `standard.ts` (`formatIssues` — shared by every package), `builder.ts` | tier-0 seam everything reports through |
| 2 | `query` | `cache.ts` (stampede), `source.ts` (NULL divergence), `read.ts` (one span per execution) | the substrate for 07/08 |
| 2 | `core` | `roles.ts`, `assert.ts`, `runtime-metrics.ts` | `resolveRole` selects pool profiles at boot |
| 2 | `seo` | `xml.ts` — the injection boundary for sitemap/RSS | security-relevant escaping |
| 3 | `db` | `branch.ts` (entire branching feature), `introspect.ts` | whole features shipped untested |
| 3 | `action` | `contract-test.ts`, `job-handle.ts`, `validate.ts`, `json-schema.ts` | the generator of everyone else's tests |
| 3 | `jobs` | drivers (`driver-nats.ts`, `driver-redis.ts`, `driver-pg-sql.ts`), `inspect.ts` | plus the suite gap below |
| 4 | `realtime` | `client.ts` (reconnect), `changefeed.ts`, `fanout.ts`, `local-store.ts` | after the 02 fixes land |
| 4 | `mail` / `mcp` / `admin` / `cli` | templates, `wire.ts`, panels, `dispatch.ts`, `cmd-db.ts` | breadth pass |

## Suite-shaped gaps (the named suffixes)

- `packages/jobs` has zero `.job.test.ts` — the suite named for the package; write step-replay, idempotency-dedupe, outbox-atomicity under the `job` gate (`verify-tests.ts:43-46` names these guarantees).
- `packages/action` has zero `.contract.test.ts` — why the vacuous contract test #2 (see 02) survived.
- `packages/ai` has zero `.eval.test.ts` at framework level (the dummy app has them).

## Broken tests to repair

- `packages/seo/src/robots.test.ts:33` — assertion behind `if (resolveEnvironment() !== 'production')`; set the environment explicitly so the test always asserts.

## Commands

- One file: `bun test packages/policy/src/evaluate.test.ts`. Live suites need `TEST_DATABASE_URL` exported. Full gate: `bun run verify`.

## Done when

- Priority 1–2 clusters covered with tests that fail on mutation (spot-check by reverting one fix from 01/02 locally); `.job.test.ts` and `.contract.test.ts` exist for jobs/action; verify summary surfaces skip counts; `bun run verify` green.
