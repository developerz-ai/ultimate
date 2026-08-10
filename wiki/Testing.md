# Testing

`bun test`. N workers, N real Postgres databases, sealed network. No mocking the database, no rollback hacks, no shared-state flakes.

Tests live next to their source as `<file>.test.ts`.

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

### Rejected approaches

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

```
X_TEST_NETWORK_EGRESS: unmocked network call
  cause: POST https://api.stripe.com/v1/charges from app/billing/service.ts:42
  fix:   x test mock https://api.stripe.com/v1/charges
```

Locale and zone are declared per test when the behavior under test depends on them — see [Timezones and dates](Timezones-And-Dates) and [I18n](I18n).

## The six test types

| Type | Command | Asserts | Runs against |
|---|---|---|---|
| **unit** | `x test unit` | pure logic — services, money, policy predicates, matchers | no DB, no I/O |
| **contract** | `x test contract` | an action's input/output schema, its policy denials, its emitted OpenAPI + MCP tool shape | cloned DB |
| **live** | `x test live` | a live query's initial snapshot, incremental patches on write, reconnect delta, and that a policy-failing row is never delivered | cloned DB + in-process replicator + in-process NATS |
| **job** | `x test job` | step-level replay (a step already run is not re-run), idempotency-key dedupe, retry/backoff, concurrency and rate limits, outbox atomicity on rollback | cloned DB + frozen clock |
| **e2e** | `x test e2e` | real browser against the built output: render mode behavior, streaming holes filling, hydration timing, SW install + offline fallback, version-skew reload | built app + cloned DB |
| **eval** | `x test eval` | prompt quality vs. a baseline: exact, schema, rubric (judge), or regression tolerance | pinned models, recorded fixtures |

Each type is a first-class runner with its own fixture shape — not a naming convention on top of one runner. Every command supports `--json`.

### Evals

An eval declares its cases beside the prompt (`<name>.evals.ts`) and gates on the **drop** from a
committed baseline, never on an absolute score — models drift, prompts should not.

| Rule | Code |
|---|---|
| a prompt no `defineEval` names | `X_EVAL_MISSING` |
| the run mean or a case fell past `tolerance` | `X_EVAL_THRESHOLD` |
| the baseline was never recorded | `X_EVAL_BASELINE_MISSING` |

```ts
export const summarizeEval = defineEval({
  name: 'summarize',
  prompt: summarizePrompt,
  cases: [{ name: 'refund', vars: { ticket: 'I want my money back' }, expected: 'billing' }],
  scorers: [exact, jsonSchemaValid(['category', 'summary'])],
  baseline: import.meta.resolve('./summarize.baseline.json'),
  tolerance: 0.05,
});
```

`ULTIMATE_EVAL_RECORD=1 x test eval` re-records every baseline, so accepting a new number is a
reviewable diff instead of an edited threshold.

```ts
// contract test — generated as a scaffold with the action
test('publishPost denies a non-owner', async ({ seed, actorFor }) => {
  const { post, stranger } = await seed('two-orgs');
  await expect(publishPost.as(actorFor(stranger), { postId: post.id }))
    .rejects.toBeUltimateError('X_POLICY_DENIED');
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

The `job` example is the one that matters: it asserts the durability guarantee, not that mail was sent. See [Jobs and workflows](Jobs-And-Workflows) and [Policies and authz](Policies-And-Authz).

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

The single gate. Green means shippable.

Seventeen steps, one list, in cost order. There is no `--only` and no `--skip` — "green" has to mean
the same thing for everyone. A step with nothing to check reports as skipped (`-`), never as passed.

| Step | Fails on |
|---|---|
| `typecheck` | any error; `any` is banned by lint, not tolerated by a cast |
| `lint` | formatting, `any`, default exports, bare `Error`, raw hex colours, hardcoded user-facing strings, `Intl` date formatting with no `timeZone` |
| `boundaries` | `site/` → `app/`, routes → DB, services → HTTP, tier violations in framework packages |
| `filesize` | a source file over 500 lines |
| `package-shape` | a workspace package missing `README.md`, `CLAUDE.md`, `tsconfig.json`, or `src/index.ts` |
| `errors` | an `X_*` code with no runnable fix or no docs page |
| `unit` | pure logic — services, money, policy predicates, matchers |
| `contract` | action/query schemas, policy denials, emitted OpenAPI and MCP shapes |
| `live` | live-query snapshot, incremental patches, reconnect delta, policy-filtered rows |
| `job` | step replay, idempotency dedupe, retry/backoff, concurrency, outbox atomicity |
| `e2e` | the built output under Playwright, offline and SW update included |
| `eval` | a prompt scoring below its committed baseline, or a prompt with no eval at all |
| `drift` | schema differs from migrations, or a migration is not reversible-or-marked |
| `contract-diff` | a breaking change to a published action/query without a version bump |
| `budgets` | per-route JS bytes and LCP |
| `manifest` | `x.manifest.json` / `openapi.json` differ from what the code produces |
| `roadmap` | framework repo only — a milestone missing its status marker, or a shipped milestone missing an artifact its own row names |

Any failure fails the gate; flakes are failures.

```
$ x verify
  ✓ typecheck  ✓ lint  ✓ boundaries  ✓ filesize  ✓ package-shape  ✓ errors
  ✓ unit  ✓ contract  ✓ live  ✓ job  ✓ e2e  ✓ eval
  ✗ drift
      X_DB_DRIFT: schema differs from migrations
        cause: table "posts" has column "publish_at" not present in any migration
        fix:   x db gen "add publish_at"
```

`x verify --json` emits the same content machine-readably → [MCP and AI](MCP-And-AI). CI runs exactly `x verify` — no bespoke pipeline steps, because a check that lives only in CI is a check developers cannot run.

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_TEST_NETWORK_EGRESS` | a test reached the network without a mock | `x test mock <url>` |
| `X_POLICY_DENIED` | the actor's policy refused — the assertion target of every denial test | grant the permission, or assert the denial |
| `X_INVARIANT` | a domain invariant was violated inside a test fixture | fix the seed or the invariant |
| `X_CONFIG_INVALID` | test config names an unknown worker count, driver, or test type | `x test --help` |

Full list: [Error codes](Error-Codes).

## Rules

- Never mock the database. Clone it.
- Never assert on wall-clock time. Advance the frozen clock.
- Never let a test reach the network unmocked — it fails by design.
- A flaky test is deleted or fixed the day it flakes. There is no `retry: 3`.
- Every framework package ships at least 2 tests that would catch a real regression. No `expect(true).toBe(true)`.
- Tests live next to their source as `<file>.test.ts`.
- A denial test per policy branch, not one happy-path test per action.
- Assert on error **codes**, never on error message text.
- CI runs `x verify` and nothing else.
