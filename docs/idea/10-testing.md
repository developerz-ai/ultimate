# Testing

`bun test`. N workers, N real Postgres databases, sealed network. No mocking the database, no rollback hacks, no shared-state flakes.

## Parallel by database clone

```
bun test --workers 8
  worker 0 → myapp_test_0   (CREATE DATABASE myapp_test_0 TEMPLATE myapp_test_tpl)
  worker 1 → myapp_test_1
  ...
```

| Step | Mechanism |
|---|---|
| Once per run | build a template DB: migrate + seed → `myapp_test_tpl` |
| Per worker | `CREATE DATABASE myapp_test_N TEMPLATE myapp_test_tpl` — Postgres file-copies, typically 100–400ms |
| Per test file | truncate the tables that file touched, or take a savepoint if it declares `readonly` |
| Teardown | drop on exit; `--keep-db` to inspect a failure |

Why not the usual approaches:

| Common approach | Why rejected |
|---|---|
| Wrap each test in a transaction and roll back | breaks anything that commits: the outbox, `LISTEN/NOTIFY`, logical replication, real isolation levels, nested transactions, and every job test. You end up testing a code path production never runs |
| One shared test DB with serial tests | slow, and the first flake teaches everyone to re-run instead of read |
| One shared DB with parallel tests | shared-state flakes. The failures are order-dependent, unreproducible, and eventually the suite is ignored |
| Mock the database | tests pass, SQL is wrong. The main thing worth testing is the query |

Real databases, truly parallel, is the only combination that is both fast and honest.

## Determinism

Any test that can pass twice and fail the third time is worse than no test — it trains people to ignore red.

| Control | Behavior |
|---|---|
| **Seeds** | `seed(name)` builds a named, deterministic fixture graph via entity factories. Same input → identical rows, identical UUIDs |
| **Frozen clock** | time starts at a fixed instant. `clock.advance('3d')` moves it, and it also drives `step.sleep` and cron in tests |
| **Seeded RNG** | `Math.random`, `crypto.randomUUID`, and Bun's RNG are seeded per test file from its path — reproducible, distinct across files |
| **Sealed network** | any egress not explicitly mocked **fails the test** with `X_TEST_NETWORK_EGRESS`, naming the URL and the fix |
| **Fixed timezone + locale** | `UTC` and `en-US` unless a test declares otherwise; a tz-dependent bug fails deterministically |
| **Ordered concurrency** | job workers in tests run deterministically; `runJobs()` drains the queue synchronously |

Sealed network is the highest-value rule: it converts "the suite is slow and occasionally fails" into "you forgot to mock Stripe, here is the line".

## The six test types

| Type | Command | Asserts | Runs against |
|---|---|---|---|
| **unit** | `x test unit` | pure logic — services, money, policy predicates, matchers | no DB, no I/O |
| **contract** | `x test contract` | an action's input/output schema, its policy denials, its emitted OpenAPI + MCP tool shape | cloned DB |
| **live** | `x test live` | a live query's initial snapshot, incremental patches on write, reconnect delta, and that a policy-failing row is never delivered | cloned DB + in-process replicator + in-process NATS |
| **job** | `x test job` | step-level replay (a step already run is not re-run), idempotency-key dedupe, retry/backoff, concurrency and rate limits, outbox atomicity on rollback | cloned DB + frozen clock |
| **e2e** | `x test e2e` | real browser against the built output: render mode behavior, streaming holes filling, hydration timing, SW install + offline fallback, version-skew reload | built app + cloned DB |
| **eval** | `x test eval` | prompt quality vs. a baseline: exact, schema, rubric (judge), or regression tolerance | pinned models, recorded fixtures |

Each type is a first-class runner with its own fixture shape — not a naming convention on top of one runner.

```ts
// contract test — generated as a scaffold with the action
test('publishPost denies a non-owner', async ({ seed, actorFor }) => {
  const { post, stranger } = await seed('two-orgs');
  await expect(publishPost.as(actorFor(stranger), { postId: post.id }))
    .rejects.toBeUltimateError('X_FORBIDDEN');
});
```

```ts
// job test — the step guarantee, not the happy path
test('onboardOrg retries only the failed step', async ({ seed, clock, mail }) => {
  const { org } = await seed('fresh-org');
  mail.failOnce(nudgeEmail);
  await runJobs(onboardOrg, { orgId: org.id });
  clock.advance('3d');
  const trace = await runJobs.drain();
  expect(trace.steps.provision.executions).toBe(1);       // replayed from storage
  expect(trace.steps['nudge'].executions).toBe(2);        // only this one retried
});
```

## Generated scaffolds

Every primitive emits a test scaffold that fails until filled in — an untested action is a red build, not a backlog item.

| Primitive | Scaffold |
|---|---|
| `action` / `mutator` | schema round-trip + one denial case per policy branch |
| `query` (`live: true`) | snapshot + one incremental patch + one policy-filtered row |
| `job` | idempotency dedupe + one step-retry case |
| `route` | metadata presence, budget, and offline strategy |
| `llm` prompt | an evals file (missing evals fails `x verify`) |

## `x verify`

The single gate. Green means shippable ([axiom 5](./00-thesis.md)).

| # | Check | Fails on |
|---|---|---|
| 1 | typecheck | any error; `any` is banned by lint, not tolerated by a cast |
| 2 | lint (Biome) | formatting, `any`, default exports, bare `Error`, raw hex colours, hardcoded user-facing strings |
| 3 | **import boundaries** | `site/` → `app/`, routes → DB, services → HTTP, tier violations in framework packages |
| 4 | all six test types | any failure; flakes are failures |
| 5 | **migration drift** | schema differs from migrations, or a migration is not reversible-or-marked |
| 6 | **contract diff** | a breaking change to a published action/query without a version bump |
| 7 | budgets | per-route JS bytes, LCP/CLS, Lighthouse thresholds, precache size |
| 8 | SEO + i18n | missing title/description, duplicate meta, broken internal link, missing i18n key |
| 9 | manifest freshness | `x.manifest.json` / `openapi.json` differ from what the code produces |

```
$ x verify
  ✓ typecheck  ✓ lint  ✓ boundaries  ✓ unit  ✓ contract  ✓ live  ✓ job  ✓ e2e
  ✗ migration drift
      X_DB_DRIFT: schema differs from migrations
        cause: table "posts" has column "publish_at" not present in any migration
        fix:   x db gen "add publish_at"
```

`x verify --json` emits the same content machine-readably, per [`09-ai-first.md`](./09-ai-first.md). CI runs exactly `x verify` — no bespoke pipeline steps, because a check that lives only in CI is a check developers cannot run.

## Rules

- Never mock the database. Clone it.
- Never assert on wall-clock time. Advance the frozen clock.
- Never let a test reach the network unmocked — it fails by design.
- A flaky test is deleted or fixed the day it flakes. There is no `retry: 3`.
- Every framework package ships at least 2 tests that would catch a real regression.
- Tests live next to their source as `<file>.test.ts`.
