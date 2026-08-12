# Testing

Bun's own runner, one real Postgres database per test worker, sealed network. No mocking the database, no rollback hacks, no shared-state flakes. The runner is not reinvented — it is wrapped, per [`00-thesis.md`](./00-thesis.md#wrap-dont-reinvent).

## One database per worker

Which process a test runs in decides which database it gets. `workerId` reads `ULTIMATE_TEST_WORKER` first, then Bun's own `BUN_TEST_WORKER_ID` / `JEST_WORKER_ID`, then falls back to the pid ([`packages/testing/src/template-db.ts`](../../packages/testing/src/template-db.ts)).

| Command | Processes | Databases |
|---|---|---|
| `bun test` | 1, worker 0 | 1 |
| `x test [type] --workers N` | N file shards, each child run with `ULTIMATE_TEST_WORKER=0..N-1` | N |
| `bun test --parallel=N` | N, Bun's own split — implies `--isolate`, workers 1..N | N |

**There is no `bun test --workers` flag.** `--workers` belongs to `x test` ([`packages/cli/src/cmd-test.ts`](../../packages/cli/src/cmd-test.ts), [`test-shards.ts`](../../packages/cli/src/test-shards.ts), largest-first bin packing over file size); `--parallel` belongs to Bun.

| Step | Mechanism |
|---|---|
| Once per run | `pg_advisory_lock(hashtext(template))`, then `CREATE DATABASE "ultimate_test_template" TEMPLATE template0` + migrate. The first worker in builds it; the rest wait on the lock and reuse it |
| Per worker | `DROP DATABASE IF EXISTS "ultimate_test_template_wN" WITH (FORCE)`, then `CREATE DATABASE … TEMPLATE "ultimate_test_template"` — Postgres file-copies |
| No `TEST_DATABASE_URL` / `DATABASE_URL` | PGlite in memory behind the same handle, so `bun test` works on a laptop with nothing installed |
| Teardown | `drop()` on the worker's handle |

Not shipped, and not implied: per-file truncation, a `readonly` savepoint mode, and a `--keep-db` flag to inspect a failure. A worker's database is cloned fresh and dropped; that is the whole lifecycle today.

### The gate shards; a scaffolded app still does not

`As of 2026-08`, stated because the paragraph above is easy to read as more than it is:

| Claim | Reality |
|---|---|
| `x verify` shards tests | **yes**, since the gate was routed through the same shard machinery `x test` uses. `unit`, `contract`, `job` and `eval` run N `bun test` children over an LPT bin-packed split; `--workers N` overrides the default |
| every step shards | **no.** `live` and `e2e` are serial by declaration (`SERIAL_TYPES`). A logical replication slot is named at the Postgres **cluster** level, not inside a database, so a per-worker database does not isolate it and two workers race `pg_create_logical_replication_slot`. `e2e` runs against one built `dist/` and one browser profile |
| a scaffolded app tests in parallel | **still no.** `x new` writes `"test": "bun test"` ([`templates/scaffold-repo.ts`](../../packages/cli/src/templates/scaffold-repo.ts)) |
| parallel is faster here | **measured, and it depends on the machine.** On this 12-core box `unit` went 63s → 24s. On a free 4-core `ubuntu-latest`: serial 43.2s, 3 workers 44.8s, 6 workers 34.8s — which is why the default oversubscribes rather than leaving a core spare |
| `[test] parallel = N` in `bunfig.toml` turns it on | **no.** The flag is CLI-only; the config key is ignored |

**Sharding is not free, and one line of the cost is a bug we are paying to hide.** Each worker
reloads the framework's module graph, and the shards run with `--isolate` — a fresh module registry
per *file* — which costs 2.65× on its own (454 files: 49.9s plain, 132.1s isolated).

`--isolate` is there because process-global state leaks between test files. `@ultimat3/policy` keeps
its declared permission set in a module global and treats an empty set as "allow anything", so the
first file to call `definePermissions` flips the whole process strict and every later file using an
undeclared permission fails. Serial passes **by accident of glob order**: `packages/query`'s tests
free-ride on a permission `packages/cli`'s tests happen to declare first. An 8-way split surfaced
36 failures from that one cause. Tests that pass by accident are not tests, and the fix is for each
file to declare and clear its own permissions — not to keep paying `--isolate` to hide it.

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
| **Per-table factory seeds** | `defineFactory` derives its seed from the table name unless given, so two entities never draw the same uuid stream — a shared `seed: 1` let a join assertion pass for the wrong reason |

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

## Fixtures you write once

The framework's own vocabulary for "less test code", which is the same bet as [wrap, don't reinvent](./00-thesis.md#wrap-dont-reinvent) one level down — the framework wraps the runner, the app wraps the framework, and the agent writes the assertion.

| Tool | Does | Rule that keeps it honest |
|---|---|---|
| `defineFactory(table, …)` with **traits** | one declaration, N named variants of a row | a trait is a named override, never a second factory |
| `associate(…)` | a factory that builds its parent | the association is built with the strategy that asked: `build()` never reaches a database, `create()` writes the parent first |
| `create()` | persist through the one write seam, `usePersister` | a factory taking a repo argument would put the seam at every call site |
| `sharedExamples(name, body)` / `behavesLike(name, subject)` | one contract asserted against every implementation of it | `behavesLike` calls `describe`, so it goes at declaration scope — Bun rejects a `describe` inside a test body |

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

The single gate. Green means shippable ([axiom 5](./00-thesis.md)). **17 steps**, in this order — `VERIFY_STEPS` in [`packages/cli/src/cmd-verify.ts`](../../packages/cli/src/cmd-verify.ts) is the executable copy.

| # | Step | Fails on |
|---|---|---|
| 1 | typecheck | any error; `any` is banned by lint, not tolerated by a cast |
| 2 | lint (Biome) | formatting, `any`, default exports, bare `Error`, raw hex colours, hardcoded user-facing strings |
| 3 | **boundaries** | `site/` → `app/`, routes → DB, services → HTTP, tier violations in framework packages |
| 4 | filesize | a source file past the ceiling |
| 5 | package-shape | a package missing its declared exports, or version skew across the lockstep release |
| 6 | errors | a `fix:` that names no command, an `X_*` code with no documented row |
| 7–12 | unit · contract · live · job · e2e · eval | any failure; flakes are failures. A type with no files of its own is skipped — except `eval`, which also fails on a prompt with no eval |
| 13 | **drift** | schema differs from migrations |
| 14 | **contract-diff** | a breaking change to a published action/query without a version bump |
| 15 | budgets | per-route JS bytes, precache size |
| 16 | manifest | `x.manifest.json` differs from what the code produces, or `AGENTS.md` is absent |
| 17 | roadmap | a milestone row with no status marker, or one marked ✅ whose named artifacts are not on disk ([`14-roadmap.md`](./14-roadmap.md)) |

A skipped step is never counted as a passing one. The summary carries both numbers and names the
skips — `12 of 17 steps passed in 53224ms — 5 skipped: job, eval, drift, contract-diff, budgets` —
so a green gate that is green because the suite does not exist has to say so on the one line every
reader sees. `all 17 steps passed` means seventeen steps actually ran.

**The floor: a step that once applied must keep applying.** Naming the skips makes them visible;
`x.verify.json` is what makes one *fail*. It is hand-written and committed — `{ "steps": [...] }`,
the steps this repo has already proved it can run — and the gate reads it and never writes it. A
step in that list that reports nothing to check is a suite somebody deleted, so it is recorded as
**failed and not as skipped** (`X_VERIFY_SUITE_VANISHED`), which puts it in the failure count, in
`data.failed`, and in every step table a reader or another gate parses. A repo that commits no
floor is not ratcheted; a floor naming a step the gate does not run enforces nothing and says so
through the `manifest` step, because a typo that silently covers no suite is the same false green.

```
$ x verify
  ✓ typecheck  ✓ lint  ✓ boundaries  ✓ unit  ✓ contract  ✓ live  ✓ job  ✓ e2e
  ✗ drift
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
