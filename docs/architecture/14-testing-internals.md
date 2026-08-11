# Testing internals

`bun test`. N workers, N real Postgres databases, sealed network. Never mock the database — clone it. Rationale and rejected alternatives: [`../idea/10-testing.md`](../idea/10-testing.md).

## Template DB cloning

```
bun test --workers 8
  once:        migrate + seed  →  myapp_test_tpl
  per worker:  CREATE DATABASE myapp_test_N TEMPLATE myapp_test_tpl   (~100-400ms)
  per file:    truncate the tables that file touched
  teardown:    drop on exit;  --keep-db to inspect a failure
```

| Phase | Mechanism | Constraint |
|---|---|---|
| Build the template | apply every migration, run the base seed, `ANALYZE` | done once per run; skipped when the migration checksum set is unchanged and the template exists |
| Close template connections | the builder disconnects before cloning | Postgres refuses `CREATE DATABASE ... TEMPLATE t` while any session is connected to `t` — this is the #1 flake in naive implementations |
| Clone | `CREATE DATABASE myapp_test_N TEMPLATE myapp_test_tpl` | file-level copy, no SQL replay; cost is data size, not migration count |
| Serialize clones | clone statements run one at a time | concurrent clones of the same template contend; the loop is short enough that serializing costs less than retrying |
| Reset between files | `TRUNCATE ... RESTART IDENTITY CASCADE` on the tables the file wrote (tracked by a session hook) | a file declaring `readonly` gets a savepoint instead |
| Teardown | `DROP DATABASE ... WITH (FORCE)` | `--keep-db` skips it and prints the connection string |

## Worker → DB assignment

| Step | Detail |
|---|---|
| Worker identity | `bun test` exposes a stable worker index; the fixture reads it once at module init |
| Name | `${app}_test_${workerIndex}` — deterministic, so a failed run's database is findable by index |
| Connection | the pool for that process is built from a rewritten `DATABASE_URL`; `env.DATABASE_URL` inside a test resolves to the worker's clone |
| Sticky per file | a test file runs entirely on one worker, so one file = one database for its lifetime |
| Cross-worker isolation | absolute. No shared rows, no shared sequences, no shared advisory locks (lock keys are namespaced by worker index) |
| Realtime tests | the replicator and NATS run **in-process** against the worker's clone, so live tests never touch shared infrastructure |
| Leak detection | at teardown, an open transaction or an unreleased advisory lock fails the file with the offending pid and query |

## Determinism

A test that can pass twice and fail the third time is worse than no test — it trains people to ignore red.

| Control | Mechanism | Failure it removes |
|---|---|---|
| **Seeds** | `seed(name)` builds a named fixture graph via entity factories; ids are derived from a hash of `(seedName, entity, index)` | "works on my machine" from random ids landing in a different sort order |
| **Frozen clock** | time starts at a fixed instant; `clock.advance('3d')` moves it and also drives `step.sleep`, cron, TTLs, and lease expiry | tests that fail at midnight, or only in CI's timezone |
| **Seeded RNG** | `Math.random`, `crypto.randomUUID`, and Bun's RNG seeded per file from its path — reproducible, distinct across files | two files generating the same "random" key and colliding |
| **Sealed network** | any egress not explicitly mocked fails with `X_TEST_NETWORK_EGRESS`, naming the URL and the fix | a suite that is slow and occasionally red because a third party is |
| **Fixed tz + locale** | `UTC` and `en-US` unless declared otherwise | a DST bug that reproduces only in October ([`10-cross-cutting.md`](./10-cross-cutting.md)) |
| **Ordered concurrency** | job workers run deterministically; `runJobs()` drains the queue synchronously | a job test that depends on scheduler timing |
| **Stable ordering** | queries in tests require a total order, same as production | pagination assertions that pass by accident |

### Why unmocked egress must fail

An unmocked HTTP call is three bugs at once: the test is slow, the test is flaky, and the test is **lying** — it asserts behavior that depends on a system nobody in CI controls. Worse, it hides the interesting case: nobody writes the timeout test, the 500 test, or the malformed-response test, because the happy path "works".

```
X_TEST_NETWORK_EGRESS: unmocked request in a test
  cause: POST https://api.stripe.com/v1/charges from apps/web/app/billing/service.ts:41
  fix:   http.mock('POST https://api.stripe.com/v1/charges', { status: 200, body: {...} })
```

The trap is installed at the fetch/socket layer, so it catches SDKs and transitive dependencies, not just direct `fetch` calls. A server the test itself started is not egress — `start()` announces its socket to core, so a request back to that port passes. There is no allowlist API a file can call; the one opt-out is `ULTIMATE_TEST_ALLOW_NET=1` in the environment, reserved for a deliberate live integration, so no test can quietly unseal the network for itself.

## The six test types

Each is a first-class runner with its own fixture shape — not a naming convention over one runner.

| Type | Command | Asserts | Runs against |
|---|---|---|---|
| **unit** | `x test unit` | pure logic: services, money math, policy predicates, matcher predicates | no DB, no I/O |
| **contract** | `x test contract` | an action's input/output schema, its policy denials, and its emitted OpenAPI + MCP tool shape | cloned DB |
| **live** | `x test live` | a live query's initial snapshot, incremental patches on write, reconnect delta, and that a policy-failing row is **never delivered** | cloned DB + in-process replicator + in-process NATS |
| **job** | `x test job` | step-level replay, idempotency dedupe, retry/backoff, concurrency and rate limits, outbox atomicity on rollback | cloned DB + frozen clock |
| **e2e** | `x test e2e` | real browser against the built output: render-mode behavior, streaming holes filling, hydration timing, SW install + offline fallback, version-skew reload | built app + cloned DB |
| **eval** | `x test eval` | prompt quality vs. a baseline: exact, schema, rubric (judge), or regression tolerance | pinned models, recorded fixtures |

### The eval step, in detail

Two rules, both inside one step of `x verify`:

| Rule | Shape | Fails with |
|---|---|---|
| Coverage | every registered prompt is named by a `defineEval` | `X_EVAL_MISSING` |
| Regression | the run mean and every case, against the committed baseline | `X_EVAL_THRESHOLD` |

Coverage is read from the app's own registries, never from filenames, so renaming a file cannot
un-gate a prompt. It is why the eval step **applies with no eval suite at all**: an app whose only
prompt has no eval would otherwise skip the step and report a green gate over untested code.

The regression rule gates on the **drop**, not the absolute score. An absolute floor fails every
eval at once the day a provider ships a slightly different model, which teaches everyone to lower
thresholds until they measure nothing. `tolerance` is how far a score may fall; the run mean *and*
each case are compared, because a mean that holds while one case collapses is the regression an
eval exists to catch.

| Situation | Outcome |
|---|---|
| never recorded | `X_EVAL_BASELINE_MISSING` — gating on nothing is not passing |
| corrupt baseline | `X_EVAL_BASELINE_INVALID` — never read as "absent, so pass" |
| accepting new numbers | `ULTIMATE_EVAL_RECORD=1 x test eval`, then commit the diff |
| recording during `x verify` | `X_EVAL_RECORDING`, and the suite does not run — recording passes by definition and would overwrite the committed baselines mid-gate |

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

Generated scaffolds fail until filled in — an untested primitive is a red build, not a backlog item:

| Primitive | Scaffold |
|---|---|
| `action` / `mutator` | schema round-trip + one denial per policy branch |
| `query` (`live: true`) | snapshot + one incremental patch + one policy-filtered row |
| `job` | idempotency dedupe + one step-retry case |
| `route` | metadata presence, budget, offline strategy |
| `llm` prompt | an evals file — missing evals fails `x verify` |

## `x verify` — order and reasons

```
$ x verify
  ✓ typecheck  ✓ lint  ✓ boundaries  ✓ unit  ✓ contract  ✓ live  ✓ job  ✓ e2e
  ✗ migration drift
      X_DB_DRIFT: schema differs from migrations
        cause: table "posts" has column "publish_at" not present in any migration
        fix:   x db gen "add publish_at"
```

| # | Check | Fails on | Why here |
|---|---|---|---|
| 1 | typecheck | any error; `any` is banned by lint, not tolerated by a cast | fastest signal, and everything downstream assumes types hold |
| 2 | lint (Biome) | formatting, `any`, default exports, bare `Error`, raw hex, hardcoded strings | seconds, and it catches the cross-cutting rules before an expensive test run |
| 3 | **import boundaries** | `site/` → `app/`, routes → DB, services → HTTP, framework tier violations | an import-scan pass; a boundary break invalidates the bundle-graph assumptions the later budget check depends on |
| 3a | file size | a source file over 500 lines | a file read; one file, one job is cheapest to check before anything runs |
| 3b | package shape | a workspace package missing `README.md`, `CLAUDE.md`, `tsconfig.json`, `src/index.ts` | four `stat` calls, and every later step assumes the package is navigable |
| 4 | unit tests | any failure | no DB, so still cheap; fails fast on logic |
| 5 | contract, live, job tests | any failure; a flake **is** a failure | needs cloned databases — first genuinely expensive step |
| 6 | **migration drift** | schema ≠ migrations ≠ catalog, or an irreversible migration without a marker | after tests, because tests are what would have exercised the new column |
| 7 | **contract diff** | a breaking change to a published action/query without a version bump | needs the manifest the previous steps validated |
| 8 | budgets | per-route JS bytes, LCP/CLS, Lighthouse thresholds, precache size | requires a full build — the most expensive step |
| 9 | SEO + i18n | missing title/description, duplicate meta, broken internal link, missing i18n key | needs the built route table and the extracted key set |
| 10 | manifest freshness | `x.manifest.json` / `openapi.json` differ from what the code produces | last, because earlier steps may legitimately regenerate it |
| 11 | e2e | render modes, streaming, hydration, SW install, offline fallback, skew reload | needs the built output from step 8 |

Ordering principle: **cheapest and most informative first**, and never run a check whose result would be meaningless because an earlier one failed. Steps 1–4 complete in seconds, which is what makes the local loop usable.

### Why it is the shippability contract

| Property | Consequence |
|---|---|
| CI runs exactly `x verify` | a check that lives only in CI is a check developers cannot run |
| One command, one exit code | "is this shippable" has a yes/no answer, not a dashboard |
| `--json` on the whole run | an agent parses failures, reads each `fix:`, applies it, re-runs — the loop closes without a human ([`04-error-contract.md`](./04-error-contract.md)) |
| Every check names a file and a fix | "budgets failed" is not an instruction; "chart.js via shared/ui/button.tsx" is |
| Flakes are failures | there is no `retry: 3`. A flaky test is fixed or deleted the day it flakes |
| No bypass | no `--skip`, no `SKIP_TESTS=1`. Green is the only definition of done (axiom 5) |

```json
{"ok":false,"checks":[{"name":"budgets","ok":false,"failures":[
  {"route":"site/pricing","metric":"js","actual":"61kb","limit":"40kb",
   "cause":"chart.js via shared/ui/button.tsx",
   "fix":"x fix boundary site/pricing/page.tsx"}]}]}
```

## Rules

- Never mock the database. Clone it.
- Never assert on wall-clock time. Advance the frozen clock.
- Never let a test reach the network unmocked — it fails by design.
- A flaky test is deleted or fixed the day it flakes.
- Every framework package ships at least 2 tests that would catch a real regression. `expect(true).toBe(true)` fails review.
- Tests live next to their source as `<file>.test.ts` ([`00-conventions.md`](./00-conventions.md)).
