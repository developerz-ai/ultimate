# @ultimat3/testing

The harness. Never mock the database — clone it. Never assert on wall-clock time — advance the
frozen clock. Never let a test reach the network unmocked — it fails by design.

`bun add @ultimat3/testing` · guide: [Testing](https://github.com/developerz-ai/ultimate/wiki/Testing)

```ts
import { expect, unitTest } from '@ultimat3/testing';

unitTest('the clock moves only when the test moves it', ({ clock }) => {
  const before = clock.now().getTime();
  clock.advance('1h');
  expect(clock.now().getTime() - before).toBe(3_600_000);
});
```

## What it owns

| Module | Owns |
|---|---|
| `harness.ts` | `describeApp()` / `testApp()` — boot an app in-process with its own database |
| `template-db.ts` | N workers, N databases, one migrated template, `CREATE DATABASE ... TEMPLATE` |
| `determinism.ts` | frozen clock, seeded RNG, seeded uuids, `assertDeterministic` |
| `stub.ts` | `stub(action \| llm() \| query \| job)` — the body answers from a script (`stub-script.ts`); see [Test doubles](#test-doubles) |
| `swap-adapter.ts` | `swapAdapter(port, impl)` — one `ADAPTER_PORTS` port replaced for one test, through its `./adapter` installer |
| `test-scope.ts` | when a double is put back: after its test, or at its file's end — the preload's hooks, never the file's |
| `matcher-stub.ts` · `matcher-doubles.ts` | `toHaveBeenCalledWith` on a stub; `toHaveEnqueued`, `toHaveSentMail` |
| `sealed-network.ts` | any unmocked `fetch`, `WebSocket` or `Bun.connect` egress fails, with the URL and the line that fixes it |
| `sealed-sockets.ts` | the `WebSocket` and `Bun.connect` patches, behind `sealed-network.ts`'s one gate |
| `factories.ts` | `defineFactory` — seeded rows, traits, associations, `build` vs `create` |
| `factory-registry.ts` | `factoriesFor(registry)` — one factory per entity, each value read off its column's declaration (default, enum, kind, money, nullability) through `$parse`, never off its name |
| `seed-graph.ts` | `seedGraph(entities, { tenants, perTable, seed, factories, beside })` — rows for every table with no factory written: parents first, same-tenant keys, every declared rule kept. Pure, same seed same bytes |
| `repro.ts` | `reproduce(bundle, { driver })` and `reproJob(runJobs, failure)` — what a test `x repro --write` generated calls: captured reads seeded, clock frozen at the failure, the same actor and input (masked fields stood in from the schema); a dead job's completed steps replayed from storage |
| `seed-graph-plan.ts` | the plan's types and `insertSeedGraph(graph, writer)` — every insert, then every deferred key, sequentially |
| `seed-graph-values.ts` | one column's candidate values, off its declaration, kept only where `$parse` accepts them — `factoriesFor`'s source too |
| `seed-graph-order.ts` · `seed-graph-row.ts` · `seed-graph-shape.ts` | insert order over `$references()` (a cycle broken at a nullable key) · one row solved against invariants and unique keys · what the graph reads off an entity, structurally |
| `seed-graph-error.ts` | `X_SEED_GRAPH_UNSATISFIED`, its fix naming the `defineFactory` to write; `X_SEED_GRAPH_ENTITY_UNKNOWN`, a plan and a writer built from two entity sets |
| `seed-writer.ts` | `entitySeedWriter({ entities, client })` or `({ entities, driver? })` — the `SeedWriter` that writes a graph through each entity's own repository: Postgres or PGlite through a client, or a driver. `@ultimat3/entity` loads on the first write. `snapshot(rows)`, required on every `SeedWriter`, reads rows back as one digest each (`md5(t::text)` over a client), `null` for a row gone |
| `exercise.ts` | `runExercisePass({ entities, writer, roles, seed?, overrides?, only? })` — every registered action, query and job once, each on its own committed tenant pair, one `ExerciseRecord` per primitive, the tenant proof's verdict on its `tenant`. What `x exercise` runs |
| `define-exercise.ts` | `defineExercise({ <name>: { actor, input?, runs? } \| { off: '<why>' } }, { actor?: <entity>, factories?: { <entity name>: defineFactory(…) }, setup?: () => mockFetch(…) \| cassette(…) })` — an app's overrides (the second argument names the entity whose rows are the actors, and the factories that build a table no generated row satisfies — a cross-column `satisfies` — keyed by entity name, unknown ones `X_DECLARATION_UNKNOWN`), `apps/web/exercise.ts`'s one export; a blank `off` is `X_CONTRACT_EXERCISE_UNDECLARED`, an unknown name `X_DECLARATION_UNKNOWN` when the pass runs |
| `exercise-setup.ts` | `withExerciseSetup(room, setup)`: the app's `setup` run inside the sealed room before the first row, its handle disposed before the room restores the network; an `allowHost` in it is `X_EXERCISE_SETUP_UNSEALED`. Types `ExerciseSetup`, `ExerciseSetupHandle` |
| `exercise-actor.ts` · `exercise-input.ts` · `exercise-report.ts` | the first `x policy explain` actor the policy allows, minted in the primitive's tenant · the input: override, then a seeded id by field stem, then the minimal draw (`@ultimat3/schema/sample`, loaded dynamically) · the room one run executes in (network sealed, mail captured, clock frozen) and its record |
| `exercise-override-line.ts` | `overrideLine`, the entry an unreached record says to paste: valid TS — the actor the pass ran as (`testActor(name, { roles, permissions }).actor`, `null` signed out, left out when the entry declares one) and each id field bound to the seeded row the pass used; an id it could not bind is the string `UNBOUND_ID` |
| `tenant-proof.ts` | internal (`CROSS_TENANT_SCOPE` is `@ultimat3/entity`'s): `proveTenant` — B with A's ids, A's own call, B again; each B leg between two snapshots of A's rows. `withoutCrossTenant` strips `tenancy:cross` (`CROSS_TENANT_SCOPE`) from B; `publicReason` decides `public` |
| `tenant-canary.ts` | internal: `tenantTaint` — one tenant's rows, ids and marks (row canaries, key parts of `MIN_TAINT_ID_LENGTH` 8 or more no other tenant shares); `findTaint` — every path holding one |
| `exercise-crash.ts` | internal: `proveCrash` — a job the pass reached, run through `crashProof` with its control's input and actor, after the tenant proof; the `CrashProof` on `ExerciseRecord.crash` |
| `scale-sweep.ts` · `scale-sweep-graph.ts` · `scale-sweep-run.ts` · `exercise-sweeps.ts` | `judgeScale(small, large)`, pure · one tenant at a size, its rows of no tenant pointed at the pass's own · the two sized runs · both sweeps after the pass, onto each record's `scale` and `plans` |
| `plan-oracle.ts` · `plan-sweep.ts` · `plan-sweep-fix.ts` · `plan-sweep-report.ts` | `judgePlan(answer, tables)`, pure: the red nodes · `sweepPlans(client, sent, entities)`: `PREPARE` + `explain execute` in a read-only transaction · verdict to `indexes:` line · the coded findings `x exercise` prints |
| `job-crash-proof.ts` | `crashProof(handle, input, { context?, seed? })` — one clean run, then the worker killed at every step boundary it crossed, then each answer lost; `{ boundaries, divergences, reruns }`, a divergence carrying its `X_JOB_CRASH_DIVERGED` |
| `job-simulate.ts` | `simulateJobs({ seed?, seeds, jobs, workers, faults, invariant })` — seeded races on the shared simulated driver; `X_JOB_SIM_INVARIANT`, `X_JOB_SIM_NONDETERMINISTIC`; `x test job --seed <n>` replays one |
| `fault-proxy.ts` | `faultProxy({ target })` — a Bun TCP proxy whose mode switches mid-run: `pass`, `delay(ms)`, `blackhole` (bytes held, never dropped), `reset`, `refuse` |
| `drills.ts` · `drill-verdict.ts` | the eight fault drills (`x drill`) and the verdict over evidence alone; a property with no evidence is red, and an answer may reach the load `DRILL_ANSWER_SLACK_MS` (500) past the deadline it was given by |
| `drill-fleet.ts` · `drill-run.ts` | `startDrillFleet` — `web`, `worker` (and `sync` for `nats-down`) as processes on a scratch database, every service behind a proxy; `runDrill` — baseline, fault, recovery, judged |
| `drill-load.ts` · `drill-writes.ts` | the load's lanes; `drillWriteTargets` — every action an anonymous POST reaches, each request a fresh seeded draw with the app's `exercise.ts` override, so a job enqueued over HTTP is on the table for `worker-sigkill`/`worker-sigterm` |
| `drill-sync.ts` | `startDrillSync` — the sync-client lane: `hello`, resubscribe, redial on a drop, every `replay-gap` counted; `sync-resumes` reads it |
| `tenant-proof-report.ts` | `tenantProofFindings` — one coded finding per crossing (`X_TENANT_LEAK`, `X_TENANT_WRITE_CROSSED`), `tenantFindingLines` the human lines. Paths, tables and seeded ids, never a bound value |
| `e2e-a11y.ts` | the accessibility audit's rules: `NAMED_ROLES`, `auditTree`, the in-page probe for `<html lang>` and focus under `aria-hidden` |
| `e2e-a11y-run.ts` | one `e2eTest`'s audit: read after every navigation and at the end, a reasoned `allow`, findings deduplicated per suite, `X_E2E_A11Y_VIOLATION` |
| `e2e-a11y-tabs.ts` | the same audit on every raw tab a session builds, failed from the preload's `afterEach`; `allowA11y([{ role, selector, because }])` is its exception |
| `ax-node.ts` | the one reader of the browser's accessibility nodes — `toAxNode` (one element, `x shot`'s) and `toAxTreeNodes` (a whole tree, the audit's) |
| `factory-persist.ts` | `usePersister` — the one seam `create()` writes through |
| `shared-examples.ts` | `sharedExamples` / `behavesLike` — one rule, many subjects |
| `test-types.ts` | the six test types and their helpers — four of them take the fixture bag, as `test` does |
| `auth-request.ts` | `authRequest()` — the two arguments an app's authenticator is handed, built for real |
| `island-state-mount.ts` | `describeIslandState()` / `mountIslandState()` — one declared island state, mounted, with the setup and teardown a mount owes |
| `matchers.ts` | `toBeUltimateError` `toDenyPolicy` `toEmitSteps` `toMatchOpenApi` `toBeWithinBudget` `toRejectInput` `toAcceptInput` `toEqualRow` `toBeVisible` |
| `matcher-row.ts` | `toEqualRow` — equality over every OWN property, so a `.sealed()` column (not enumerable on a repository row) is compared; a server-only difference is named, never printed |
| `test-seal-key.ts` | the throwaway master key a test process seals under when the app has none — installed by the preload, handed to the app `startE2eApp` spawns, exported from nowhere |
| `local-tx.ts` | `memoryLocalTx()` — the client store a mutator's `local()` half writes into under test, with the record store's own rules |
| `render-view.ts` | `renderView()` / `renderRoute()` — what the server renders, for a unit test: one component, or a whole route module with its `load`, `meta` and islands |
| `retry.ts` | the one retry loop every waiting assertion is built from — a budget, a fixed interval, and an injectable sleep |
| `fixtures.ts` | the registry + `test('…', ({ clock }) => …)` injection |
| `fixture-{clock,mail,jobs,network,statements}.ts` | the five fixtures the framework builds in-process |
| `fixture-drivers.ts` | the five it declares but a driver must build — `page` `budget` `signIn` `deploy` `subscribe` |
| `fixture-island.ts` | `mountIsland()` — build an island, import its chunk, run its `mount`. The BUILDER is a parameter |
| `island-dom.ts` | the micro-DOM `mountIsland` drives: what compiled Solid touches, and nothing else |
| `island-selector.ts` | the selector grammar `find`/`all` read — compounds and two combinators — and the refusal for the rest |
| `island-observers.ts` | `ResizeObserver`, recording; `deliverResize` is the test's hand on the browser's layout |
| `island-states.ts` | the vocabulary: what a photographable island STATE is. Types and constants, importing nothing |
| `define-island-states.ts` | `defineIslandStates()` — one manifest, validated and frozen, with every default resolved |
| `island-states-check.ts` | the rules a declaration must satisfy, as pure functions answering a fault |
| `island-states-pure.ts` | the guard the design rests on: a `*.island.states.ts` file reaches no browser and no bundler |
| `island-shot-targets.ts` | the expansion — one record per PICTURE — and `islandAddress` / `parseIslandAddress`, inverses |
| `island-states-resolve.ts` | a name a reader typed → the manifest it meant; a manifest → the island file it claims |
| `framework-fixtures.ts` | registers both sets; the app registers only what it owns |
| `registry-leak-guard.ts` | fails the run naming the FILE that left a process-global registry dirty, and restores the ones that can be restored at the same boundary |
| `registry-snapshot.ts` | `captureProcessRegistries()` / `restoreProcessRegistries()` — the locale config, the catalogs, the permission set, the role map, the tasks and the declared measurement actor, put back as a file inherited them. A module-scope declaration evaluates once per process (`bun test` without `--isolate`, `As of 2026-08`), so a neighbour's `clearPermissions()` is otherwise permanent |
| `registry-isolation.ts` | `isolateEntityRegistry()` — an empty entity registry, and the process's back after. Its own entry point (`@ultimat3/testing/registry-isolation`), never the barrel: it value-imports `@ultimat3/entity`, and the barrel is what a tier-0 test imports for `expect` |
| `quiet-logs.ts` | a green run prints the reporter and nothing else: the framework's log lines go to a sink that drops them. `LOG_LEVEL=info bun test <file>` shows them — naming `LOG_LEVEL` is the one escape hatch, and a level above `info` filters what the TERMINAL shows, never what the logger emits (below). A test asserting on log output hands `structuredLogger({ level, writer })` its own writer, or installs its own `setLogSink` and restores the previous one |
| `preload.ts` | the bunfig preload that installs all of the above |

## Install

```toml
# bunfig.toml
[test]
preload = ["@ultimat3/testing/preload"]
```

The preload also sets `ULTIMATE_SECRETS_KEY` to a fixed throwaway key, so a test over a
`.sealed()` column runs on a fresh clone and in CI, where `.secrets.key` (gitignored) is absent.

| Rule | |
|---|---|
| Only a test process | `NODE_ENV=test`, which `bun test` sets. A server that imported the preload gets no key |
| The app's key wins | nothing is installed when the variable is set or `.secrets.key` exists |
| e2e | `startE2eApp` hands the same key to the reset, the seed and the app it spawns |
| Not an export | the key is module-private; `installTestSealKey` is not on the barrel |

## Fixtures

`test` from this package — and `unitTest`, `contractTest`, `liveTest`, `jobTest` — passes a
fixture bag as the first argument, and builds only what the body destructures: a test that never
names `runJobs` never starts a queue, and one that destructures nothing builds nothing.

```ts
import type { JobHandle } from '@ultimat3/jobs';
import { expect, unitTest } from '@ultimat3/testing';

declare const onboardOrg: JobHandle<{ orgId: string }>; // yours
declare const orgId: string;

unitTest('the three-day sleep releases the worker', async ({ clock, runJobs }) => {
  await runJobs(onboardOrg, { orgId });
  expect(await runJobs.inFlight()).toBe(0);   // suspended, not waiting
  clock.advance('3d');
  expect(await runJobs.due()).toBe(1);
});
```

One body shape for all five (`FixtureBody`), so a job body under the `unit` step is `unitTest`
with `{ runJobs }` — never `describe(testName('unit', …))` around a bare `test` to reach a fixture.

| Fixture | Is | Built by |
|---|---|---|
| `clock` | `now()` · `advance('3d')` · `set(instant)` on the frozen clock | the preload |
| `mail` | `outbox()` · `lastTo(address)` · `failOnce(mail)` over an in-memory transport | the preload |
| `network` | `offline()` · `drop()` · `online()` · `state()` over the sealed network | the preload |
| `push` | a Web Push runtime with the push service and the device played in-process: `subscribe(actorId, { locale })` gives that person a browser, `sent()` is what each device would SHOW (decrypted with its own key), `answerOnce(410 \| 429 \| …)` scripts the push service | the preload |
| `runJobs` | a worker: call it to enqueue+drain, then `enqueue()` `drain()` `due()` `inFlight()` `depth()` — see [below](#a-job-under-runjobs) | the preload |
| `statements` | every statement the test issued: `all()` `count(fingerprint?)` `shapes()` — and an N+1 throws | the preload |
| `page` | the browser: `goto` `gotoStreamed` `getByRole` `evaluate` `waitForServiceWorker({ timeoutMs? })` — an uncontrolled first page is reloaded once for its worker (`e2e-service-worker.ts`) | a browser driver |
| `budget` | `jsBytes(route)` measured off the built output | a browser driver |
| `signIn` | put the browser session in a member's shoes | a browser driver |
| `deploy` | `newBuild()` — same app, new build id, page still open | a browser driver |
| `subscribe` | one subscriber's `rows()` `patches()` `settled()` `lsn()` | a replicator |
| anything else | whatever the app registers | the app's `scripts/test-setup.ts` |

The last five are **declared but not built**: the name resolves, and destructuring one in a process
with no driver fails as `X_TEST_FIXTURE_UNAVAILABLE`, naming the driver rather than telling you to
register a fixture that is not yours to define. A driver arrives through the same registry —
`defineFixtures` merges, last registration wins — so there is no second seam to learn.

The declaration is also the driver's type: `defineFixtures` holds every name `Fixtures` declares to
the type it was declared with, so a half-built `page` is a compile error at the registration rather
than a missing method three awaits into a later test.

`mail`, `network` and `runJobs` install a process-global driver for the length of one test and hand the previous one back afterwards — the state they *found*, not a fixed default, so an outer fixture already offline stays offline when an inner one disposes. A fixture that takes over a global does the same: implement `Symbol.dispose` or `Symbol.asyncDispose` on what the factory returns, and `fixtureTest` calls it in reverse build order — including when the test body throws. Going offline is the `network` fixture's job and only its job; the gate's writer is not exported, because a test that set it directly would skip that disposal and take every later file down with it.

An app adds its own with `defineFixtures` and widens the type by augmenting `Fixtures`:

```ts
defineFixtures({ seed: () => loadSeed, actorFor: () => actorFor });

declare module '@ultimat3/testing' {
  interface Fixtures {
    readonly seed: (name: string) => SeedHandle;
  }
}
```

Destructuring a name nobody registered fails with `X_TEST_FIXTURE_UNKNOWN`, which names the set
that *is* registered — never `undefined is not an object` from inside the body. A name that is
registered but has no driver fails with `X_TEST_FIXTURE_UNAVAILABLE` instead; the two are different
instructions, so they are different codes.

## A job under `runJobs`

```ts
import { serviceActor } from '@ultimat3/core';
import type { JobHandle } from '@ultimat3/jobs';
import { expect, unitTest } from '@ultimat3/testing';

declare const reindexPost: JobHandle<{ id: string; orgId: string }>; // yours
declare const chargeInvoices: JobHandle<{ orgId: string }>;
declare const id: string;
declare const orgId: string;

unitTest('a row deleted before the run is skipped, not failed', async ({ runJobs }) => {
  const trace = await runJobs(reindexPost, { id, orgId });
  expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
  expect(trace.executions[0]?.result).toEqual({ skipped: true });   // what the BODY returned
  expect(Object.keys(trace.steps)).toEqual(['load']);
});

unitTest('the sweep runs as the billing worker', async ({ runJobs }) => {
  const worker = serviceActor({ id: 'billing-worker', scopes: ['billing:run'] });
  await runJobs(chargeInvoices, { orgId }, { actor: worker, tenantId: orgId });
});
```

| | |
|---|---|
| **`trace.executions[n].result`** | what the body returned, on a completed run — `undefined` for a body that returns nothing, and no such key on a run that failed, suspended or was interrupted. It is `executeJob`'s own (`JobExecution.result`): `{ skipped: true }` and "did the work" are otherwise one trace |
| **`trace.steps[name]`** | `executions` (a replay from storage does not count), `attempts`, `status` — cumulative for the test |
| **`{ actor }`** | on the call and on `drain()`: the identity the WORKER runs as — what an app wires through `WorkerOptions.context()`. Its org is replaced by the job's declared tenant, as a real worker's is; `tenant: 'none'` strips it. Absent is core's anonymous actor |
| **`{ tenantId }`** | on the call and on `enqueue()`: the ENQUEUER's tenant on the row — the limiter's bucket and the dedupe namespace, the half of `handle.as(actor, input)` that reaches the queue. Never the tenant the body runs under: that is the job's own `tenant:` |
| **one event bus per fixture** | `step.waitForEvent` reads an ambient bus that STORES; the fixture installs a fresh one and hands the process's back, so one test's `publishEvent` cannot resume the next test's run |
| **a real worker's pass** | each round is `jobWorker(...).tick()`: admission, the limiter and keyed `concurrency` (`whenBusy: 'fail'` settles `refused`, `X_JOB_KEY_BUSY`) hold exactly as in production |
| **a cancel reaches a running body** | the worker renews its lease on the TEST clock — every millisecond of it — and a renewal that misses the row aborts `ctx.signal` with `X_JOB_LEASE_LOST`: start `runJobs.drain()`, cancel the row (`cancelJob(jobDriver(), id)` or the app's own action), `clock.advance(1)`, await the drain. No hand-built worker, no sleep, no wall-clock timer |

## Test doubles

One way per need. Every double is put back by the preload's own hooks: made inside a test, after
that test; made outside one (`beforeAll`, module scope), at the end of its file. No `afterEach`, no
`restore()`, nothing a skipped block can leave behind.

| Need | The one way |
|---|---|
| an action, an `llm()`, a query or a job answers what the test says | `const s = await stub(chargeCard); s.returns(out)` — `.returns(a, b)` answers in order, the last repeats; `.throws(new YourError(…))` |
| it was called, with this input | `expect(s).toHaveBeenCalledWith(input)` — the input is parsed by the primitive's schema first |
| who called it, how often | `s.calls` — `{ input, actor }[]`, oldest first |
| a backend (queue, mail driver, event bus, store, clock, transport…) is a fake | `await swapAdapter('jobs', memoryJobDriver())` — any port in `SwappablePort` |
| a job was enqueued | `await expect(runJobs).toHaveEnqueued(sendWelcome, { userId })` |
| a mail was sent | `expect(mail).toHaveSentMail(welcomeMail, { to: address })` |
| a vendor's HTTP answer | `mockFetch` / `cassette()` — [Sealed network](#sealed-network) |
| time | the `clock` fixture |
| rows a test reads by name | `const { ada } = await seed('demo').pick({ ada: 'member:ada' })` — the app registers `defineFixtures({ seed: seedFixture({ seeds: [demo], driver: () => appDriver }) })` once; `demo` is a `factorySeed` ([Factories](#factories)) |
| one row, here | a factory: `await postFactory.create()` ([Factories](#factories)) |

```ts
import type { Action } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import type { JobHandle } from '@ultimat3/jobs';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { expect, stub, unitTest } from '@ultimat3/testing';

// Yours: two actions (or an llm()), a job, a mail and a member.
declare const chargeCard: Action<
  StandardSchemaV1<{ cartId: string; cents: number }>,
  StandardSchemaV1<{ chargeId: string }>
>;
declare const checkout: Action<StandardSchemaV1<{ cartId: string }>, StandardSchemaV1<unknown>>;
declare const sendReceipt: JobHandle<{ cartId: string }>;
declare const receiptMail: { readonly id: string };
declare const member: Actor & { readonly email: string };
declare const cartId: string;

unitTest('checkout charges the cart and queues the receipt', async ({ runJobs, mail }) => {
  const charged = await stub(chargeCard);
  charged.returns({ chargeId: 'ch_1' });
  await checkout.as(member, { cartId });             // the real action, calling the stubbed one
  expect(charged).toHaveBeenCalledWith({ cartId, cents: 1200 });
  await expect(runJobs).toHaveEnqueued(sendReceipt, { cartId });
  await runJobs.drain();
  expect(mail).toHaveSentMail(receiptMail, { to: member.email });
});
```

What a stub replaces is the BODY, and nothing else:

| Still real | Why it matters |
|---|---|
| the policy, the input parse, the rate limit, the meter, idempotency | a stub cannot hide a refusal the caller would meet |
| the output schema | a canned answer the declaration would reject fails the call, as it would in production |
| every surface — a direct call, `.as()`, HTTP, MCP, `.job()`, a worker pass | the stub is seen wherever the primitive is reached |
| `errors:` | a scripted `throws` of an undeclared code is `X_ERROR_UNDECLARED`, as a real one is |

| Refusal | When |
|---|---|
| `X_TEST_STUB_UNANSWERED` | the stub was called before `.returns()` / `.throws()` |
| `X_TEST_STUB_TARGET_UNSUPPORTED` | `stub()` was handed something that is not an action, `llm()`, query or job |
| `X_TEST_EXPECTED_INPUT_INVALID` | an assertion's expected input fails the primitive's own schema — no call could have matched it |
| `X_TEST_ADAPTER_PORT_UNSWAPPABLE` | the port has no process-global slot; the cause says what a test does instead (`UNSWAPPED`) |
| `X_TEST_SCOPE_UNINSTALLED` | no `@ultimat3/testing/preload`, so nothing would put the double back |
| `X_TEST_RUN_JOBS_EXPECTED` / `X_TEST_MAIL_EXPECTED` | the matcher's receiver is not the `runJobs` / `mail` fixture |

`toHaveBeenCalledWith` keeps bun's meaning for a `mock()` or a `spyOn`: only a `stub()` receiver is
schema-checked. `As of 2026-11`.

## An N+1 fails the test it happened in

```ts
test('the feed reads its authors once', async ({ statements }) => {
  await renderFeed();                              // a per-row findById throws here:
  //   X_N_PLUS_ONE_QUERY: members.findById ran 5 times in one request — one read per row
  //   fix: db.posts.preload('author')   # one statement for the whole page
  expect(statements.count('posts.findMany')).toBe(1);
  expect(statements.shapes()[0]?.count).toBe(1);
});
```

Opting in is naming it. `statements` subscribes to the `db.statement` bus event for the length of
one test and unsubscribes afterwards, so there is no `strict: true` to remember and no
suite-wide switch to forget.

| | |
|---|---|
| **the unit of work is the test** | `x dev`'s ledger counts per request and skips a statement issued outside one; a unit test calling `posts.findById(id)` has no request anywhere, and that is the loop it was written to catch |
| **one threshold** | `N_PLUS_ONE_THRESHOLD` from `@ultimat3/entity`, the number `x dev` warns at. A loop that fails a test and a loop that warns in dev are the same loop |
| **one error** | `nPlusOne()`'s, so the `fix:` is the `preload()` the schema's own relations spell — never a line this package composes |
| **it fails the test at teardown** | `As of 2026-11` (v31): the bus contains a subscriber's throw, so the loop runs to its end and the fixture raises the first verdict when it is disposed — the error names the shape (`members.findById`) and its count, and its stack is the looping line's: the fixture holds core's `captureStatementStacks()` for its lifetime, so both drivers stamp the sender's stack (`DbStatementEvent.callerStack`) before their first `await` — a cost production, which never holds it, does not pay. One verdict per shape, readable earlier through `verdicts()`; a body that swallows every error cannot swallow it |
| **measurement ≠ verdict** | `all()` `count()` `shapes()` count every statement, `expectedQueryLoop` ones included; only the verdict honours the suppression |

`expectedQueryLoop(reason, fn)` from `@ultimat3/db` stays the one way to declare a loop deliberate —
there is no flag on the fixture and no code to silence.

## The six test types

| Helper | Asserts | `x verify` step |
|---|---|---|
| `unitTest` | pure logic, no I/O | `unit` |
| `contractTest` | OpenAPI diff vs the committed spec, MCP exposure | `contract` |
| `liveTest` | exactly what each subscriber receives | `live` |
| `jobTest` | step sequence, retries, idempotency | `job` |
| `e2eTest` | a browser driver; with none registered it SKIPS, and the gate's `e2e` step passes over the skip — ask `hasE2eDriver()` rather than reading that as a pass. Every one audits the page's accessibility tree; the only exception is `{ a11y: { allow: [{ role, selector, because }] } }` ([Testing](https://github.com/developerz-ai/ultimate/wiki/Testing#the-accessibility-audit)) | `e2e` |
| `evalTest` | LLM output scoring against a threshold | `eval` |

Each takes an optional `{ timeoutMs }` after the body — `unitTest(name, body, { timeoutMs: 30_000 })`,
and `test` takes the same; `evalTest` reads it off its options — handed to `bun:test` as that
test's own deadline (`TestOptions`), at this machine's pace. Absent is Bun's 5 s default, which
`x verify` paces the same way. An `E2eDriver` receives it as its third argument.

**`paced(ms)`** is a declared deadline at this machine's pace, for a bare `test(…, paced(90_000))`:
`ms` times `ULTIMATE_TEST_PACE`, which `x verify` measures and sets on every test run it starts —
1 on a 4-core CI runner, more on a 2-core or slower box. Absent (a hand-run `bun test`) is 1; a
value that is not a number at or above 1 is `X_TEST_PACE_INVALID`. `unitTest`, `contractTest`, `liveTest` and `jobTest` hand their body the
[fixture bag](#fixtures); `e2eTest` hands its own (`E2eFixtures`).

**Registering one, `As of 2026-08-25`.** `@ultimat3/cli`'s `installE2eDriver({ page, baseUrl })` is
the driver that exists — a `PageLike` over `@ultimat3/scraping`'s browser — and an app's test preload
is what calls it. It returns the undo, and `resetE2eDriver()` is the seam's inverse for anything that
installs one by hand: `bun test` is one process, so a driver left registered reaches every later file.

It registers `page` and nothing else. `budget`, `signIn` and `deploy` keep refusing with
`X_TEST_FIXTURE_UNAVAILABLE`, and so do `E2eFixtures`' `offline()` / `online()` / `update()` — the
browser's own network state and a second build id are not things a page port can answer for, and a
fixture that silently no-opped would make the assertion after it read as proof.

**A browser call that is never answered says why.** `X_CDP_TIMEOUT` from the connection carries
`meta.reading` — `target-gone` (session detached, target destroyed or crashed), `lost-in-transport`
(`meta.framesDropped` frames arrived unparseable after the call) or `no-answer` — beside
`framesArrived`, `lastFrames` (the last 8), `transportOpen` and `navigations`; `cause` is the
one-line reading. `E2eSession.offline(false)` rejects with `X_CDP_CALL_FAILED` when a page that is
still there refuses to take `navigator.onLine` back: the restore is attempted regardless, and the
page stays in the set.

Each helper prefixes the test name with its type (`job · onboards an org`), which is what
`bun test --test-name-pattern "job · "` selects — the six lines of `x verify` come from the tests
themselves, not from a directory convention.

## Factories

```ts
import { belongsTo, defineFactory, hasMany } from '@ultimat3/testing';

const orgFactory = defineFactory(orgs, {
  defaults: (n, ids) => ({ id: ids.uuid(), slug: `org-${n}`, name: `Org ${n}` }),
});
const postBase = defineFactory(posts, {
  defaults: (n, ids) => ({ id: ids.uuid(), orgId: '', slug: `post-${n}`, title: `Post ${n}` }),
  traits: { published: { status: 'published', publishedAt: new Date('2026-01-05T09:00:00Z') } },
  transient: { shout: false },
  belongsTo: { org: belongsTo(orgFactory, 'orgId') },
  afterBuild: (post, { transient }) => {
    if (transient.shout) post.title = post.title.toUpperCase();
  },
});
const commentFactory = defineFactory(comments, {
  defaults: (n, ids) => ({ id: ids.uuid(), orgId: '', postId: '', body: `Comment ${n}` }),
  belongsTo: { post: belongsTo(postBase, 'postId') },
});
const postFactory = postBase.extend({ hasMany: { comments: hasMany(commentFactory, 'postId') } });

postFactory.build();                                    // memory: org built alongside, nothing written
const post = await postFactory.with('published').create({ comments: 2 }); // the STORED row
const org = await orgFactory.create();
await postFactory.createList(3, { org });               // reuses that org, makes none
postFactory.attributesFor();                            // an action input: no id, no orgId
```

| | |
|---|---|
| **strategies** | `build` (memory, never a database), `create` (writes, answers the row AS STORED: declared defaults, generated columns, timestamps), `attributesFor` (an input: no primary key, no `belongsTo` key, no transient), `buildList` / `createList` |
| **sequence** | `index` (`n` above), per factory, shared by every `with()` view and `extend()` child — ids never repeat |
| **trait** | a named partial (or `(n, ids, transient) => partial`). `with('a', 'b')` composes left to right; a call's override wins. An undeclared one fails at `with()` (`X_TEST_FACTORY_TRAIT_UNKNOWN`) |
| **transient** | declared defaults a call may override; read by `defaults`, traits and callbacks; never written |
| **callbacks** | `afterBuild(row, ctx)` on both strategies before any write; `afterCreate(storedRow, ctx)` after the row and its children are stored |
| **inheritance** | `factory.extend({ defaults, traits, transient, hasMany, afterBuild, afterCreate })` — same table, same sequence, its defaults over the parent's, callbacks chained after |
| **`belongsTo`** | the parent made with the child's strategy; `{ org: row }` reuses a row; `{ orgId }` makes none. The `defaults` must name the key, so a key that is not a column does not compile |
| **`hasMany`** | `{ comments: 2 }` or `{ comments: [{ body: 'a' }, {}] }`: made after the parent, key set from the stored parent; on the answer as a non-enumerable `post.comments`, so the row itself `toEqual`s a read of the table |
| **tenant** | the tenant column follows the parent; the tenant's own association resolves first, so a comment, its post and its post's author share one org |
| **persister** | `create()` writes through the entity's own repository on `defaultDriver()`; an app that names its driver installs `usePersister(entityPersister({ driver }))` (or `{ client }`) once in its test preload |
| **seeded per table** | the default seed is derived from the table name, so two tables never draw the same uuid |
| **lint** | `await assertFactoriesValid({ orgFactory, postFactory, … })`: every factory and each trait alone, built and created against its entity on a throwaway driver; one `X_TEST_FACTORY_INVALID` naming each `factory.with('trait').strategy()` and the entity's own code |
| **seeds** | `factorySeed('demo', async ({ id }) => { await postFactory.create({ org: await orgFactory.create({ id: id('org:acme') }) }) })` is a `Seed` (`x db seed demo`, or `.run({ driver })`): every sequence restarts, every write is the seed's idempotent insert — a replay writes nothing |

`factoriesFor(registry)` builds one factory per registered entity, each value read off the
column's declaration — its default, an enumerated value, its kind, `null` only where nullable — and
kept only if the column's `$parse` accepts it; never off its name. A non-`entity()` column, or one
that refuses every generated value, is `X_SEED_GRAPH_UNSATISFIED` at `build()`. Enough for the rows a
test does not care about; `defineFactory` is for the rows it does.

`seedGraph(entities, options)` is the same value source over a whole schema: every table, parents
first, each child keyed to a parent of its own tenant, a cycle broken at a nullable key and set by an
update. It returns a plan; `insertSeedGraph(graph, writer)` writes it, and `entitySeedWriter` is
the writer over the app's own repositories. Rules and options:
[Testing](https://github.com/developerz-ai/ultimate/wiki/Testing#a-whole-graph-seedgraph).

`runExercisePass` is that graph put to work: every registered action, query and job, called once as
an actor its policy allows, on rows it did not have to write. `x exercise` and the gate's `exercise`
step drive it; an app only writes `apps/web/exercise.ts`'s `defineExercise({ … })` for what the pass
cannot guess. [Testing](https://github.com/developerz-ai/ultimate/wiki/Testing#the-exercise-pass).

An override's `input` is awaited, and runs inside the request its call runs in, so
`useContext().actor` is the seated actor that call acts as. That is the one way to hand the pass an
input no draw can forge — a challenge issued to THIS actor, signed by `softAuthenticator` — computed
from the pass's own state, per call, the scale sweep's included. Declare it `async`: `x drill`'s load
has no pass behind it, so it leaves an `async` input out and says why (`drill-writes.ts`). Postly's
passkey entries are the worked example (`examples/dummy/apps/web/exercise.ts`).

Around each call the pass runs the tenant proof: the pair's second tenant (B, same role, no
`tenancy:cross`) sends A's own input before A's call and again after it. A canary or unhanded id of
A's in B's output, mail, outbound body or enqueued job input is `X_TENANT_LEAK`; a digest of A's
seeded row that moved across a B leg is `X_TENANT_WRITE_CROSSED`. Both are red in `x exercise`.
`ExerciseRecord.tenant` is a `TenantProof`:

| `verdict` | When — first match wins |
|---|---|
| `crossed` | any `TenantFinding` (`code`, `leg: 'before' \| 'after'`, `path` or `table` + `id`) |
| `unproven` | A's own call was not `reached` |
| `public` | the policy admits an anonymous caller: read half skipped, write half kept |
| `unproven` | a query whose A answer held none of A's rows |
| `proven` | otherwise |

Absent on `off` and `refused` records. Only `crossed` is red.
[Testing](https://github.com/developerz-ai/ultimate/wiki/Testing#the-tenant-proof).

A reached job is then killed at every step boundary — `crashProof` with its control's input and
actor — and `ExerciseRecord.crash` is a `CrashProof`. The runs commit on the pass's database: job
bodies run outside any transaction (`@ultimat3/jobs` `execute.ts`), so no rollback scope could
hold them, and the proof runs after the control so its runs meet the rows the control left.

| `verdict` | When | Red |
|---|---|---|
| `diverged` | a killed run made an effect more often than the clean one: `findings[]` (`boundary`, `mode`, `effect`, `clean`, `killed`, `after?`) | yes, `X_JOB_CRASH_DIVERGED`, one per effect, fix `x exercise <job> --json` and the `step.run('<name>', …)` to wrap it in |
| `held` | no divergence; `boundaries` and `reruns` (lost answers, at-least-once) counted | no |
| `unproven` | the proof itself threw: `reason` | no |

Absent on every record but a reached job.
[Testing](https://github.com/developerz-ai/ultimate/wiki/Testing#the-crash-proof).

Then the two sweeps, with no flag to turn either off. **Scale:** every reached primitive is called
once more in a tenant seeded at 2 rows a table and once in one at 8 (`scale-sweep*.ts`); a statement
shape sent more often at 8 is a loop over rows, `ExerciseRecord.scale` `grows`, red as
`X_QUERY_SCALES_WITH_ROWS`. Under `expectedQueryLoop(reason, fn)` it is `flat`, the loop listed in
`expected` with its reason; a call that did not answer at both sizes is `unproven`, never red.
**Plans:** every distinct statement the pass sent whose first relation is an app table is planned
on the gate's database with `enable_seqscan`, `enable_bitmapscan` and `enable_sort` off — a generic
plan, so empty tables answer what the schema can serve (`plan-sweep.ts`, `plan-oracle.ts`):

| Red node | Code | Fix printed |
|---|---|---|
| `Seq Scan` on an app table, or an index scan with no `Index Cond` that no `Limit` stops | `X_QUERY_UNINDEXED` | `indexes: [{ on: [...] }]` by property, the tenant first when the statement compares it; or `scan: '<why>'` on the entity |
| `Sort` under a `Limit` | `X_QUERY_SORT_UNSERVED` | the same, the order's columns after the equality ones |

Not red: a statement whose equality pins a unique key, one a partial index serves once its value is
bound, one sent inside `expectedSeqScan(reason, fn)` or on an entity that declared `scan` (listed in
`plans.exempt`), one generic planning refuses (`plans.unplannable`). A server below Postgres 12 is
`X_QUERY_PLAN_UNAVAILABLE`, never a pass. [Testing](https://github.com/developerz-ai/ultimate/wiki/Testing#the-plan-and-scale-sweeps).

## Shared examples

```ts
const anAuthenticatedAction = sharedExamples<Action>('an authenticated action', (subject) => {
  test('denies an anonymous actor', async () => {
    // The POLICY is the receiver and the context is the argument — `toDenyPolicy` evaluates it.
    // Awaited: the decision is async, and an un-awaited assertion can never fail the test.
    await expect(subject().policy).toDenyPolicy({ actor: null, input: {} });
  });
});

describe('publishPost', () => behavesLike(anAuthenticatedAction, () => publishPost));
```

The subject is a function, not a value, for the reason `describeApp`'s accessor is: the block is
declared at module scope and the subject often does not exist until `beforeAll` has run. The
failure line reads `publishPost > behaves like an authenticated action > denies an anonymous actor`
— which subject, and which shared rule. `behavesLike` calls `describe`, so it goes at declaration
scope, never inside a test body.

### Conformance: a port's contract

Every interface an app may implement has a suite on its own entry point,
`@ultimat3/testing/conformance` (off `.`: the suites statically import the packages they hold to).
A custom adapter proves itself with one file; the shipped ones run the same suite, memory in
`unit`, Postgres / Redis / S3 / NATS in `live`. Names match `ADAPTER_PORTS[].conformance`.

```ts
import { memoryStorageDriver } from '@ultimat3/storage';
import { behavesLike, describe } from '@ultimat3/testing';
import { storageDriverConformance } from '@ultimat3/testing/conformance';

// The shipped memory driver passes; put your own `StorageDriver` where it is.
describe('my disk', () => behavesLike(storageDriverConformance, () => memoryStorageDriver()));
```

Each suite also exports its checks (`<PORT>_CHECKS`), so a test can run one against a subject that
is meant to FAIL it. The subject is called once per test.

| Interface (package) | Suite, as you call it |
|---|---|
| `AuditSink` (core) | `behavesLike(auditSinkConformance, () => ({ sink, kept, persists }))` |
| `AuthAdapter` (auth) | `behavesLike(authAdapterConformance, () => ({ adapter, clock }))` — `clock` is the `FrozenClock` it stamps from |
| `AuthLimiterFactory` (auth) | `behavesLike(authLimiterFactoryConformance, () => ({ factory, clock }))` |
| `AuthServerStore` (auth) | `behavesLike(authServerStoreConformance, () => store)` |
| `BudgetStore` (ai) | `behavesLike(budgetStoreConformance, () => store)` |
| `CacheTier` (cache) | `behavesLike(cacheTierConformance, () => tier)` — each check runs inside a request |
| entity `Driver` (entity) | `behavesLike(entityDriverConformance, () => ({ open: (entities) => driver, capabilities, foreignKeys }))` — `open` hands a driver over EMPTY tables for `entities`; an undeclared capability is asserted REFUSED |
| `ErrorGroupsStore` (admin) | `behavesLike(errorGroupsStoreConformance, () => store)` |
| `ErrorReporter` (core) | `behavesLike(errorReporterConformance, () => ({ reporter, delivered }))` — `delivered()` is the text each report left as; only a `localErrorSink`-marked reporter may carry a secret |
| `EventBus` (jobs) | `behavesLike(eventBusConformance, () => ({ bus, elapse }))` |
| `FailureStore` (core) | `behavesLike(failureStoreConformance, () => ({ store, find, client }))` |
| `Gateway` (ai) | `behavesLike(gatewayConformance, () => ({ gateway, model }))` |
| `IdempotencyStore` (action) | `behavesLike(idempotencyStoreConformance, () => ({ store, client, reclaimAfterMs, … }))` |
| `IdentityProvider` (auth) | `behavesLike(identityProviderConformance, () => ({ provider, callbackUrl, clock, answer, tamper }))` — the harness plays the IdP: `answer(redirect)` is a consenting user's callback params, `tamper(params)` alters their proof. Not an `ADAPTER_PORTS` row: an app holds several providers at once |
| `ImageTransformDriver` (seo) | `behavesLike(imageTransformDriverConformance, () => ({ driver, src }))` — `src` reads as `IMAGE_CONFORMANCE_SOURCE` (64×32 PNG) |
| `IsrStore` (render) | `behavesLike(isrStoreConformance, () => store)` — the tag-fence check runs only when `store.tagFence` exists |
| `JobDriver` (jobs) | `behavesLike(jobDriverConformance, () => driver)` |
| `LeaseStore` (jobs) | `behavesLike(leaseStoreConformance, () => ({ store, elapse }))` — every grant needs a `fence` greater than every earlier one, takeovers included (`withLock`'s token) |
| `MailDriver` (mail) | `behavesLike(mailDriverConformance, () => driver)` |
| `McpConfirmationStore` (mcp) | `behavesLike(mcpConfirmationStoreConformance, () => store)` |
| `MeterStore` (action) | `behavesLike(meterStoreConformance, () => store)` |
| `NotifyStores` (notify) | `behavesLike(notifyStoresConformance, () => ({ ledger, inbox, preferences, digest }))`; one store alone: `deliveryLedgerConformance`, `inboxStoreConformance`, `preferenceStoreConformance`, `digestStoreConformance` |
| `OutboxStore` (jobs) | `behavesLike(outboxStoreConformance, () => ({ relay, claimLeaseMs, transaction, elapse }))` |
| `Provider` (ai) | `behavesLike(providerConformance, () => ({ provider, model }))`; over HTTP also `providerTransportConformance` |
| `PurgeDriver` (cache) | `behavesLike(purgeDriverConformance, () => ({ driver, refused }))` — omit `refused` for noop |
| `PushDeviceStore` (notify) | `behavesLike(pushDeviceStoreConformance, () => store)` |
| `PushSubscriptionStore` (pwa) | `behavesLike(pushSubscriptionStoreConformance, () => store)` |
| `RateLimitStore` (http) | `behavesLike(rateLimitStoreConformance, () => store)` |
| `ScrapeDriver` (scraping) | `behavesLike(scrapeDriverConformance, () => driver)` — serving `SCRAPE_CONFORMANCE_PAGES` on `shop.test` |
| `SecretSource` (core) | `behavesLike(secretSourceConformance, () => ({ source, holding, empty }))` |
| `SmsTransport` (notify) | `behavesLike(smsTransportConformance, () => transport)` — `memorySmsTransport()` passes; a provider adapter (Twilio, Vonage, SNS) proves itself here |
| `SleepClock` (core) | `behavesLike(sleepClockConformance, () => clock)` |
| `StepStore` (jobs) | `behavesLike(stepStoreConformance, () => driver)` — any `JobDriver`; a lone store: `memoryJobDriver({ steps })` |
| `StorageDriver` (storage) | `behavesLike(storageDriverConformance, () => disk)` — checks write under `conformance/<uuid>/` |
| `TotpReplayGuard` (auth) | `behavesLike(totpReplayGuardConformance, () => guard)` |
| `Transport` (realtime) | `behavesLike(transportConformance, () => bus)` — fresh and open per test; the suite closes it |
| `VectorStore` (ai) | `behavesLike(vectorStoreConformance, () => store)` — unbound, `VECTOR_CONFORMANCE_DIMENSION` wide |

`elapse(ms)` is required — there is no real-time fallback: a memory store on a frozen clock passes
`clock.advance`; a database-clocked store moves its own rows back by `ms` (the Postgres
suites age `expires_at` / `claimed_at` / `published_at`), never a real sleep.

## Parallel databases

```ts
import { acquireWorkerDatabase } from '@ultimat3/testing';

// `migrate: (url) => …` applies the app's schema into the template once; omitted here.
await using db = await acquireWorkerDatabase({ adminUrl: Bun.env['TEST_DATABASE_URL'] });
```

The handle is async-disposable (`As of 2026-10-18`): `await using` drops the worker's database when
the scope ends, a failed test included; `db.drop()` is the same call spelled by hand.

The first worker creates the template under a Postgres advisory lock and migrates it; every
worker then clones it copy-on-write, under the same lock — a clone waits only 5 s for a session on
the template to leave, and the next worker's migration holds one. With no Postgres configured it falls back to PGlite, so
`bun test` works on a laptop with nothing installed.

**The gate shards; a bare `bun test` does not.** `As of 2026-08`:

| Command | Processes | Worker ids | Databases |
|---|---|---|---|
| `bun test` (what a scaffolded app's `test` script still runs) | 1 | `0` | one |
| `x verify` (`unit`, `contract`, `job`, `eval`; `live` and `e2e` stay serial) | `clamp(round(cpus * 1.5), 2, 8)` | `1..N`, from Bun's own `BUN_TEST_WORKER_ID` — `0..N-1` from `ULTIMATE_TEST_WORKER` in its coverage run | N |
| `bun test --parallel[=N]` | N (default: CPU count) | `1..N`, from Bun's own `BUN_TEST_WORKER_ID` | N |
| `x test --workers N` | N | `1..N`, from Bun's own `BUN_TEST_WORKER_ID` | N |

`ULTIMATE_TEST_WORKER` is read first so a runner-assigned shard always beats the index Bun assigns
its own `--parallel` worker — measured on Bun 1.3.14, `--parallel` populates `BUN_TEST_WORKER_ID`
and `JEST_WORKER_ID` itself, so that precedence is load-bearing rather than defensive.

**A unit test on the migrated database** is `reusableDatabase(() => migratedDatabase({ root }))`
plus `setDbClient` in `beforeAll` and `setDbClient(undefined)` in `afterAll` — the recipe in
[Testing](../../wiki/Testing.md#database-state-and-what-a-run-leaves-behind). `unitTest` grows no
database mode for it: the scaffolded handle's `testDriver()` (`@ultimat3/entity`, `As of 30.0`)
follows the installed client per call, so `db.<table>` and raw SQL meet in one database, and a
file that installs none never loads PGlite.

## The harness puts back what it found

`bun test` is one process, so `describeApp`/`testApp` teardown is a **restore**, never an uninstall.
`As of 2026-08`:

| State | Owned by | What teardown does |
|---|---|---|
| the seal on `fetch`, `WebSocket` and `Bun.connect` | the preload | unseals only if this boot was the one that sealed |
| the frozen instant, `Math.random`, `globalThis.Date` | the preload (`ULTIMATE_TEST_NOW` / `ULTIMATE_TEST_SEED`) | `restoreCapturedDeterminism(captureDeterminism())` around the boot |
| mocks, allow-listed hosts, the seen list | the boot | `resetNetwork()` |
| the cloned worker database | the boot | `db.drop()`, in a `finally` — a rejecting `app.close()` reaches it |

`installDeterminism()` runs during a boot only when the boot has something of its own to say
(`seedValue`/`now`) or nothing installed it yet, so a run configured with `ULTIMATE_TEST_NOW` is not
reset by the first `describeApp`. `restoreDeterminism()` is the process's own call, not a scope's:
it hands the real clock and the real `Math.random` back to every later **file** in the run.

## Sealed network

```text
X_TEST_NETWORK_SEALED
  cause: POST https://api.stripe.com/v1/charges was not mocked (allowed hosts: none)
  fix:   mockFetch('https://api.stripe.com/v1/charges', () => new Response('{}')) — or allowHost('api.stripe.com') if it must be real
```

A server this process booted is exempt: `httpServer().start()` announces its socket through
core's `markListening()`, so a test may call its own `handle.url()` on a kernel-assigned port with
the seal fully on. Unsealing (`ULTIMATE_TEST_ALLOW_NET=1`) stays reserved for a deliberate live
integration — never for a socket test.

**One registration answers a retry test** — `mockFetch(match, answer)`, `mockJson` inherits the match:

```ts
import { expect, mockFetch, requestLog } from '@ultimat3/testing';

declare function charge(): Promise<void>; // yours: the code under test
declare const BEARER: string;

mockFetch('POST https://api.vendor.test/charge', [
  new Response('busy', { status: 503 }),
  new TypeError('connection reset'),
  new Response('{"id":"ch_1"}'),
]);
await charge();
expect(requestLog().map((call) => call.headers['authorization'])).toEqual([BEARER, BEARER, BEARER]);
```

| Argument | Takes |
|---|---|
| `match` | an exact URL, a prefix ending in `*`, or a RegExp: every verb. A string may name one verb first (`'POST https://…'`) |
| `answer` | a handler, or a list of `Response \| Error` answered in order: the last repeats, each `Response` is cloned, an `Error` is thrown. An empty list is `X_INVARIANT` |

| Rule | Detail |
|---|---|
| `requestLog()` | `{ method, url, headers, body }[]`, in call order, refused calls included, unredacted, process-local. Header names are lowercase; `body` is UTF-8 text or `null`. `resetNetwork` clears it, `captureNetwork` carries it |
| A body is read from a clone | so a handler and the real call still get theirs. A `ReadableStream` on its way to a real server is never read and logs `null`: reading it would take its backpressure away |
| Never ahead of the answer | a stream body or a `Request`'s own is captured beside the call, so a mock answering 413 at once is not held to the stream's end: it is in the entry once it ends, `null` until then |
| A socket dial | logs `method: 'WEBSOCKET'` or `'CONNECT'`, empty `headers`, `body: null` |
| A pinned dial | an address-literal URL carrying a `host` header also matches a route on that name: `mockFetch('https://vendor.test/a', …)` answers `https://203.0.113.9/a` with `host: vendor.test`. The log keeps the URL dialled |

**A vendor's answers, recorded once** — `cassette(dir, name, options)`, `As of 2026-11`. Replay is
`mockFetch`: each recorded URL becomes one route answered in call order, so anything else is still
`X_TEST_NETWORK_SEALED`. Recording is by hand.

```ts
import { cassette, expect } from '@ultimat3/testing';

declare function refund(): Promise<{ status: number }>; // yours: the code under test

await using _tape = cassette(import.meta.dir, 'refund-flow', {
  record: { hosts: ['api.vendor.test'] },
});
expect((await refund()).status).toBe(200);
```

| Mode | What happens |
|---|---|
| replay (default) | reads `<dir>/__cassettes__/<name>.json`; no file is `X_CASSETTE_MISSING`; an entry never asked for fails at dispose, `X_CASSETTE_UNUSED` (`meta.unused`) |
| `ULTIMATE_CASSETTE=record bun test <file>` | lets `record.hosts` through the seal for the cassette's life, and writes at dispose. `CI` set, no `record.hosts`, or a dial to another host is `X_CASSETTE_RECORD_REFUSED` |

| What is written | Rule |
|---|---|
| request | never: assert what was sent with `requestLog()` |
| response headers | `content-type`, `retry-after`, `ratelimit-*` only |
| credential-named keys | masked as `[redacted]` in JSON bodies at any depth and in URL queries; a masked URL still matches the real request on replay |
| `redact(text)` | the app's rule, after the masking, on each URL and text body; a `[redacted]` it puts in a URL matches any one segment on replay |
| the secret scan | last, over the exact bytes: every credential-named env var's value and `secrets: []`, raw, JSON-escaped, percent-encoded, base64, base64url, and raw inside a base64 body. A hit writes nothing: `X_CASSETTE_SECRET` names the key and the byte offset, never the value. Values under 8 characters are skipped; a hashed or split value is not caught |
| bodies | text as text, anything else base64; keys sorted; temp file then rename; a body that fails to read writes nothing |
| streams | recorded whole, replayed as one body: a chunk-boundary test stays hand-written |

**Three dials are sealed, and only three** — `fetch`, `new WebSocket(url)` and `Bun.connect({ hostname,
port })`, behind one gate: one allow-list (`allowHost('host[:port]')`), one offline state, one
`requestLog()` record. As of 2026-11:

| Dial | Refused with | Passes through |
|---|---|---|
| `fetch` | `X_TEST_NETWORK_SEALED` / `X_TEST_NETWORK_OFFLINE` | a mock, an allowed host, a port `markListening()` announced |
| `new WebSocket(url)` | the same, thrown by the constructor before it dials | an allowed host, any loopback host |
| `Bun.connect(…)` | the same, as the rejected promise | an allowed host, any loopback host, a unix socket |

A socket to loopback is not egress on any port: it is how a test reaches a server it `Bun.listen`ed
and the compose services the live suites dial. A socket test injects its transport (`connect`,
`client`) rather than mocking the dial, so there is no `mockFetch` for one. **Not sealed:**
`node:net`, `node:tls`, `node:http(s)`, `Bun.udpSocket` and the native clients (`Bun.sql`,
`Bun.redis`, `Bun.S3Client`) — a test that must not reach the internet through those injects them.

## Rendering a page or a component

A page is a function of props and a route is a module, so a unit test renders either in process —
no server, no browser, and no cast between Solid's JSX types and the server factory's.

```ts
import type { Actor } from '@ultimat3/core';
import type { RouteModule } from '@ultimat3/testing';
import { expect, renderRoute, renderView, unitTest } from '@ultimat3/testing';

// Yours: `import { Shell } from '../../shared/shell'` and `import * as page from './page'`.
declare const Shell: (props: { nav: string; children: string }) => unknown;
declare const page: RouteModule<{ rows: readonly unknown[] }>;
declare const viewer: Actor;
declare const t: (key: string) => string;

unitTest('the dashboard counts the posts of the org that is looking', async () => {
  const view = await renderRoute(page, { url: 'https://example.test/dashboard', actor: viewer });
  expect(view.data.rows).toHaveLength(2);                 // what `load` resolved
  expect(view.meta.title).toBe(t('app.dashboard.title')); // what `meta` answered for that data
  expect(view.text).toContain(t('app.dashboard.tableTitle'));
  expect(view.html).toMatch(/<a href="\/dashboard" aria-current="page"/);
  expect(view.islands.map((island) => island.moduleId)).toEqual(['shared-theme-toggle']);
});

unitTest('the shell keeps the page in <main>', async () => {
  const view = await renderView(Shell, { nav: 'dashboard', children: 'the page body' });
  expect(view.html).toMatch(/<main[^>]*>the page body<\/main>/);
});
```

| | |
|---|---|
| **`renderRoute(module, { url?, params?, actor? })`** | the route module passed WHOLE (`import * as page`), so the page is found by the router's own rule (`pageComponentOf`). `load` runs once; `meta` and the page are handed that one object; islands are collected under the route's own `hydrate` |
| **`renderView(Component, props)`** | one component. `props` is the component's own type — a renamed prop is a compile error in the test. A component that renders an `island()` is refused here: its timing is a route's |
| **`view.html`** | the markup as the document carries it |
| **`view.text`** | what a reader sees: tags, `<script>` and `<style>` bodies removed, entities decoded, whitespace collapsed. Compare with `t('<key>')` — markup escapes what the catalog does not |
| **`actor`** | `load` and the page run inside `runWithContext(ctxOf({ actor }))`. Without one they run outside any request context, as a static page does |
| **the file stays `.test.ts`** | no JSX in a test: the registry-leak guard's loader covers `.test.ts` only, and children that need markup are a string |

`@ultimat3/render` is imported inside the two functions, so the barrel still loads no renderer.

## Testing an authenticator

An app's `configureAuthenticator()` function is handed a request and its context. `authRequest`
builds both for real — a `UltimateRequest` over a `RequestContext` — so the test calls the
function with no server and no `as unknown as Parameters<…>`.

```ts
import type { Authenticator } from '@ultimat3/http';
import { authRequest, expect, unitTest } from '@ultimat3/testing';

declare const authenticate: Authenticator; // yours — the function `configureAuthenticator()` takes
declare const token: string;
declare const key: string;

unitTest('a session cookie resolves the member it was issued to', async () => {
  const actor = await authenticate(...(await authRequest({ cookies: { session: token } })));
  expect(actor?.id).toBe('ada');
});

unitTest('an API key authenticates only under /v1', async () => {
  const [request, ctx] = await authRequest({ url: 'https://example.test/v1/posts', bearer: key });
  expect(await authenticate(request, ctx)).not.toBeNull();
});
```

| Key | Is |
|---|---|
| `cookies` | by name, sent as the ONE `cookie` header a browser sends, values percent-encoded |
| `bearer` | `Authorization: Bearer <token>` |
| `headers` | any other header; `cookies` and `bearer` win over the same header spelled here |
| `url` · `method` | `https://example.test/` and `GET` when absent |

The answer is the hook's own parameter list (`Parameters<Authenticator>`), so a parameter the hook
gains is a compile error in the test. The context is the one the `auth` stage sees: its actor is
still anonymous, because resolving it is the function under test. `@ultimat3/http` is imported
inside the function.

## Testing a sign-in against an identity provider

`As of 2026-11`. `fakeIdentityProvider({ users, issuer?, clientId?, clock? })` is an OpenID provider
served through `mockFetch`, no socket: `/.well-known/openid-configuration`, a JWKS from a key it
generates, `/authorize` approving as the chosen user, `/token` (PKCE checked) and `/userinfo`.

```ts
import { discoverOAuthProvider, registerOAuthProvider } from '@ultimat3/auth';
import { expect, fakeIdentityProvider, unitTest } from '@ultimat3/testing';

unitTest('the provider registers from its own discovery document', async () => {
  const idp = await fakeIdentityProvider({ users: [{ sub: 'ada', email: 'ada@corp.test' }] });
  const provider = registerOAuthProvider(
    await discoverOAuthProvider({ id: 'corp', issuer: idp.issuer }),
  );
  expect(provider.jwksUri).toBe(idp.jwksUri);
  idp.tamper({ wrongKey: true }); // every token from here on fails the signature check
});
```

| Member | Does |
|---|---|
| `issuer` · `clientId` · `clientSecret` · `jwksUri` | what the app's provider registration and credentials take; `issuer` defaults to `https://idp.test`, `clientId` to `fake-client` |
| `signInAs(sub)` | who `/authorize` approves as next; the first user until called |
| `tamper({ wrongAudience?, expired?, wrongKey?, noEmailVerified? })` | every token minted after it is broken that way; `tamper({})` restores honesty |
| `idToken({ sub, nonce? })` | a signed id token, for a test that skips the redirect leg |

Each tamper is refused by `@ultimat3/auth`'s real `verifyIdToken` with the code a real provider's
broken token gets (`packages/testing/src/fake-identity-provider.test.ts`). An unknown `sub` and an
empty `users` are `X_INVARIANT`.

## Testing a passkey ceremony

`As of 2026-11`. `softAuthenticator({ origin, algorithm?, counter? })` is a passkey on no device:
a real ES256 (default) or RS256 key pair on WebCrypto, `create(options)` answering what
`newPasskey` would and `get(options)` what `getPasskey` would — so the test runs
`@ultimat3/auth`'s real verifier. One implementation and one import path, `@ultimat3/auth/soft-authenticator`, which `@ultimat3/auth`'s own suites use too (auth cannot import this package).

```ts
import { defineAuth, memoryAuthAdapter, passkeyLogin } from '@ultimat3/auth';
import { softAuthenticator } from '@ultimat3/auth/soft-authenticator';
import { expect, unitTest } from '@ultimat3/testing';

unitTest('a member signs in with the passkey they registered', async () => {
  const adapter = memoryAuthAdapter();
  const ada = await adapter.createUser({
    id: '00000000-0000-7000-8000-00000000ada1',
    email: 'ada@example.test',
    passwordHash: null,
    orgId: null,
    roles: [],
    createdAt: new Date(),
  });
  const origin = 'http://localhost:3000';
  const auth = defineAuth({ adapter, passkeys: { rpId: 'localhost', origins: [origin] } });
  const passkeys = passkeyLogin(auth);
  const device = await softAuthenticator({ origin });
  const created = await device.create(await passkeys.registerOptions({ userId: ada.id }));
  await passkeys.register({ userId: ada.id, response: created });
  const asserted = await device.get(await passkeys.loginOptions());
  const signedIn = await passkeys.login({ response: asserted });
  expect(signedIn.actor.id).toBe(ada.id);
});
```

The second argument of `create` / `get` breaks exactly one check — `{ origin, type, rpId, flags,
signCount, challenge, userHandle, crossOrigin }` — so a refusal test is one line. The step-up is the
same `get` over `passkeyStepUp(…).options(…)` (`soft-authenticator.test.ts`).

## Running a mutator's local half

`local(tx, input)` is replayed on every rebase, so what a test proves is the row it leaves and that
a second application leaves the same one. `memoryLocalTx` is the store it writes into — keyed rows,
with the page record store's rules — so the test holds no hand-rolled table and no cast.

```ts
import type { MemoryLocalTx } from '@ultimat3/testing';
import { expect, memoryLocalTx, unitTest } from '@ultimat3/testing';

type RenameInput = { id: string; orgId: string; title: string };
declare const renamePost: { local(tx: MemoryLocalTx['tx'], input: RenameInput): void }; // yours
declare const id: string;
declare const orgId: string;

unitTest('the local twin marks the row pending, and a replay lands in the same place', () => {
  const store = memoryLocalTx({ posts: { [id]: { id, title: 'before', pending: false } } });
  renamePost.local(store.tx, { id, orgId, title: 'after' });
  const once = store.rows('posts');
  expect(once).toEqual({ [id]: { id, title: 'after', pending: true } });
  renamePost.local(store.tx, { id, orgId, title: 'after' });
  expect(store.rows('posts')).toEqual(once);
});
```

| | |
|---|---|
| **seed** | `{ <table>: { <key>: <row> } }`. Copied and frozen: a twin that mutates a row in place throws here rather than corrupting synced truth in a browser |
| **`update`** | a NO-OP for a key the table does not hold — a twin must not invent a row |
| **`upsert` / `update`** | an `undefined` field leaves the column alone |
| **`store.rows(table)`** | what the table holds now, by key; `{}` for a table never seen |

## Testing an island

An island is the only client-side code Ultimate ships, so it is the only code an app cannot test
by calling a function. `mountIsland` builds one with the same bundler `x build` uses, imports the
emitted chunk the way the hydration runtime does, and runs its `mount` over a DOM small enough to
read.

```ts
import { buildIslands } from '@ultimat3/cli';
import { expect, mountIsland, test } from '@ultimat3/testing';

declare const fakeFetch: typeof fetch; // yours — the island's own network, stubbed

test('the counter is reactive', async () => {
  using island = await mountIsland({
    build: buildIslands,
    root: import.meta.dir + '/../../..',
    file: 'apps/web/site/counter.island.tsx',
    props: { label: 'count' },
    shell: '<p>0</p>',                 // what the server rendered; mount must replace it
    globals: { fetch: fakeFetch },     // anything the micro-DOM does not supply
  });

  expect(island.text('[data-role="count"]')).toBe('count 0');
  expect(island.fire('button', 'click')).toBe(true);
  expect(island.text('[data-role="count"]')).toBe('count 1');
});
```

**`build` is a parameter, not an import.** `buildIslands` lives in `@ultimat3/cli`, which is tier 5
like this package, and the one declared edge between them runs `cli → testing` — so importing it
here would be a tier violation `bun run boundaries` fails on. The app supplies it, which is one
line and makes the direction visible instead of hidden.

**`fire` answers whether a handler RAN.** A selector that matches nothing and an island that
attached no handler are the same silence; the second is a bug and the first is a typo in the test.

**An `async` mount is awaited**, as the shipped hydration runtime awaits it — an island that opens
a queue or a socket before its first render (`like.island.tsx` does) needs no `settle()` helper in
the test. Until `As of 2026-08-25` the call was bare, so the fixture answered before such an island
had rendered anything and the mount later resumed against a `document` the teardown had already
removed.

**A mount installs process-global state**, so `MountedIsland` is `Disposable` — `using`, or
`island[Symbol.dispose]()` in an `afterAll`. Left installed it hands a fake `document` to every
later FILE in the run.

**Dispose also stops the island** (`As of 2026-09-07`): when `mount` returns a function, that is
the island's disposer and dispose calls it — before the globals go back, so a disposer that
removes a listener from `document` or clears an interval whose callback reads it finds the same
`document` `mount` ran under. Solid's `render` already returns exactly that, so an island's whole
side of the contract is `return render(() => <Counter {...props} />, el)` — and a disposed root
runs every `onCleanup` inside it. Until this landed, restoring the globals was the whole of the
teardown: an island whose `mount` polled on an interval kept ticking after the DOM was gone,
which surfaced as `document is not defined` thrown into whichever later test happened to be
running, and as one file's fetch stub receiving POSTs from another file's island. A `mount` that
returns nothing disposes as it always did.

### One block per declared state

Every island declares its states (below), so an island test mounts THOSE — the props a picture is
taken of are the props the test asserts on. `describeIslandState` owns what a mount owes: the
lookup, the `beforeAll` that builds and mounts, the `afterAll` that disposes.

```ts
import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import type { IslandStatesManifest } from '@ultimat3/testing';
import { describeIslandState, expect, test } from '@ultimat3/testing';

declare const counterStates: IslandStatesManifest; // yours — './counter.island.states'

const island = {
  build: buildIslands,
  root: join(import.meta.dir, '..', '..', '..'),
  shell: '<span>shell</span>',          // what the server rendered; `mount` replaces it
};

describeIslandState(counterStates, 'idle', island, (mounted) => {
  test('a click reaches the DOM through the signal', () => {
    expect(mounted().fire('button', 'click')).toBe(true);
    expect(mounted().text('[data-role="count"]')).toBe('1');
  });
});

describeIslandState(counterStates, 'long-label', island, (mounted) => {
  test('the label arrives whole', () => {
    expect(mounted().text('button')).toBe('Abrechnungseinstellungen anzeigen');
  });
});
```

| | |
|---|---|
| **`mounted()`** | an accessor, for `describeApp`'s reason: the block is declared at module scope and the mount exists only once `beforeAll` has run. Outside its block's tests it throws |
| **one mount per block** | shared by the block's tests, in order — a mount installs a process-global `document`, so two cannot be live at once |
| **one build per file** | the bundle is kept per `(build, root, island)`; a second state mounts the chunk the first one built. A build that rejects is not kept |
| **`timeoutMs`** | the mount's deadline, build included. `ISLAND_MOUNT_TIMEOUT_MS` (60 s) when absent — Bun's 5 s default is what a cold runner misses |
| **`shell` · `globals` · `size`** | `mountIsland`'s own, per block. `file` and `props` are the manifest's and are not options |
| **an id the manifest does not declare** | `X_TEST_ISLAND_STATE_UNKNOWN`, listing the declared ones |
| **`mountIslandState(manifest, id, options)`** | the same lookup for ONE test that needs its own mount — a fetch stub per test: `using island = await mountIslandState(states, 'idle', { build, root })` |

`mountIsland` stays the call for props no state declares.

### Selectors

`find`, `all`, `text`, `fire`, `resize`, `scroll` and `observing` take one grammar, `As of
2026-09-05`: a **compound** of a tag, `#id`, `.class`, `[attr]` and `[attr="value"]`
(`li[data-role="row"].odd`), joined by the **descendant** combinator (a space) and the **child**
combinator (`>`). Matching is CSS's — right to left, `>` means the direct parent, a space means any
ancestor, and a descendant walk backtracks — so `[data-role="scroller"] > ul > li button` finds
the buttons in the rows and not the one in the toolbar.

Anything else — a pseudo-class, a comma, `+`/`~`, an unquoted attribute value — throws
`X_TEST_ISLAND_SELECTOR_UNSUPPORTED` naming the offset it stopped at. It used to match nothing,
which failed the assertion after it on the wrong question.

### Layout: the box, the scroll offset, `ResizeObserver`

This DOM lays nothing out, so every box field is **0 until a test writes it**: `clientWidth`,
`clientHeight`, `offsetWidth`, `offsetHeight`, `scrollWidth`, `scrollHeight`, `scrollTop` and
`scrollLeft` are plain writable numbers on every element, `getBoundingClientRect()` derives from
the offset box at the origin, and `scrollTo({ top })` / `scrollTo(left, top)` write the offset and
run the element's `scroll` listener. A virtualized list — rows sliced by `scrollTop / rowHeight`,
a window sized by `clientHeight` — is testable end to end:

```ts
import { buildIslands } from '@ultimat3/cli';
import { expect, mountIsland } from '@ultimat3/testing';

declare const root: string; // the app root, as above
using island = await mountIsland({
  build: buildIslands,
  root,
  file: 'apps/web/app/fleet/session-list.island.tsx',
  props: { rows: 3 },
  size: { height: 640 },
});

// The host is the one element that exists BEFORE mount; `size:` is its box then.
// Everything the island creates starts at 0 and is laid out afterwards, by you:
expect(island.resize('[data-role="scroller"]', { height: 100, width: 300 })).toBe(true);
expect(island.all('[data-role="scroller"] li')).toHaveLength(3);

expect(island.scroll('[data-role="scroller"]', { top: 80 })).toBe(true);
expect(island.text('[data-role="scroller"] li')).toBe('row 3');
```

`ResizeObserver` is a constructor for the life of the mount, so an island's
`typeof ResizeObserver === 'function'` guard takes the browser's branch. It **records** — `observe`,
`unobserve`, `disconnect` — and fires nothing on its own: the browser's initial notification lands
after `mount` returns, at the next rendering opportunity, and here that opportunity is your
`island.resize(target, { width, height })`. It writes the size onto the element (`client*` and
`offset*` together) and delivers one spec-shaped entry — `target`, `contentRect`, `borderBoxSize`,
`contentBoxSize`, `devicePixelContentBoxSize` — to every observer watching **that** element, and
answers whether any did, for `fire`'s reason. `island.observing(target)` is the teardown
assertion: an `onCleanup` that forgot `disconnect()` still answers `true` after the island's
cleanup ran. The registry is per document, so nothing an earlier mount observed survives into the
next.

Not modelled: `IntersectionObserver`. Same class of gap for an infinite-scroll sentinel; it is not
here yet because no island the framework ships reads one.

## Declaring the states an island can be photographed in

A reviewer can click their way to most of a component. They cannot click their way to *the account
is read-only*, *the workspace is over quota* or *the request failed* — so those states are declared,
beside the island, in a file that is **pure data**:

```ts
// apps/web/app/settings/settings.island.states.ts
import { defineIslandStates } from '@ultimat3/testing';

export const settingsStates = defineIslandStates({
  island: 'apps/web/app/settings/settings.island.tsx',
  target: '[data-settings]',                 // what to crop to; the island's host element otherwise
  states: [
    {
      id: 'over-quota',                      // a slug: it becomes the screenshot filename stem
      title: 'the workspace is over quota',
      note: 'you cannot reach this by clicking — billing sets the flag, not the UI',
      props: { quota: { used: 120, limit: 100 } },
      routes: [{ match: 'GET /api/quota', respond: { kind: 'json', body: { used: 120 } } }],
      themes: ['dark'],                      // both, when the key is absent
    },
  ],
});
```

`islandShotTargets(manifest)` expands that to one record per picture —
`{ island, name, state, theme, viewport, target, timeZone, now, file, query }` — where `file` is
`settings/over-quota-dark.png` and `query` is the harness address that renders exactly it.
`parseIslandAddress` is that address's inverse, and it is **total**: an unknown theme falls back to
`light` rather than photographing an error page.

**Pure data is the constraint, not a preference.** The command that takes the pictures has to know
the complete expected list BEFORE a browser exists, or "produced nothing and exited 0" is
indistinguishable from success — and the harness page and this package's own guard test read the
same file. One `import './settings.island.tsx'` makes it readable by a bundler alone, so
`assertIslandStatesPure` refuses it (`X_TEST_ISLAND_STATES_NOT_PURE`).

**And no RUNTIME import of a sibling, `As of 2026-08-23`.** The rule is the relativeness, not the
extension: `./settings.island` resolves to `./settings.island.tsx` under Bun, and `./helpers` may
reach the component one hop further on — a scanner reading ONE file's text can follow neither. A
computed specifier — ``import(`./${name}.island`)`` — is refused for the same reason, because a
specifier nothing can read is not a specifier anything may call pure.

**`import type` is the one way to reach the component, and it is not an import.**
`verbatimModuleSyntax` erases a statement that BEGINS `import type` / `export type`, so
`import type { SettingsProps } from './settings.island'` costs the file nothing and types its props
against the component. An inline modifier does not: `import { type X } from './y'` is emitted as
`import {} from './y'`, which evaluates `./y`, and is refused.

| A states file writes | Verdict |
|---|---|
| `import { defineIslandStates } from '@ultimat3/testing'` | allowed — a bare specifier |
| `import type { Props } from './x.island'` | allowed — erased before anything evaluates |
| `import props from './props.json' with { type: 'json' }` | allowed — a JSON module imports nothing |
| `import { X } from './x.island'` · `./helpers` · `../shared/props` | refused — a graph this cannot follow |
| `import { type X } from './x.island'` | refused — the statement survives erasure |
| `import './x.island.tsx'` · `solid-js` | refused — JSX and a renderer |
| ``await import(`./${name}.island`)`` | refused — unreadable, and unreadable is not pure |

**Props are JSON or they are refused.** They ride the same `data-x-props` script tag hydration
already uses, so a `Date`, a function or an `undefined` is not "approximately right" in the picture
— it is a prop the component never receives. `X_TEST_ISLAND_STATE_JSON_INVALID` names the path.

**The clock is pinned in the vocabulary, zone included.** `timeZone` defaults to `UTC` and `now` to
this package's own `DEFAULT_NOW`. A harness that freezes the instant and leaves the zone ambient
renders `12:00` on one machine and `14:00` on the next, and the review diff then says the component
changed when only the reviewer moved.

`islandShotPlan(manifests)` is the same expansion over a WHOLE SET, in the order the manifests
arrived — the plan behind `x shot --all-islands`. It was exported and tested with zero callers for
its whole life, which is what made "a picture of every component state in the app" a one-line wiring
job rather than a feature.

**The command that takes the pictures is `x shot`'s, and it ships.** This paragraph said it did not
exist `As of 2026-08-23`, and `x shot --island <name>` landed on 2026-08-26 with the sweep after it.
This package still owns the vocabulary, the expansion and the refusals, and owns no browser: the
capture, the harness page and the crop are `@ultimat3/cli`'s, because `cli → testing` is the
declared edge and the reverse is a `bun run boundaries` failure.

## Launching Chrome

**Imported from `@ultimat3/scraping/cdp` since 31.0.0** — its one home, which `pdf()` prints
through: `findChrome`, `launchChrome`, `CHROME_*`, `LAUNCH_*`, `LAUNCHED_CLOSE_MS`, `cdpConnect*` and
the `Cdp*Error`s. Never re-exported here (`flight-copies`, `X_HELPER_COPY`).

`launchChrome({ executable, timeoutMs, launchTimeoutMs?, wire? })` — what the `e2e` step and `x shot`
both start a browser with. Driven over `--remote-debugging-pipe`, and on Windows — where the parent
cannot hold Chrome's fds 3 and 4 — over `--remote-debugging-port=0` and the profile's
`DevToolsActivePort` (`wire: 'pipe' | 'port'` overrides). The first answer is readiness.

`CHROME_CANDIDATES` is this platform's install list, probed after `CHROME_PATH`: the `/usr/bin` names
on Linux, the app bundles on macOS, Chrome under `%ProgramFiles%` / `%ProgramFiles(x86)%` /
`%LOCALAPPDATA%` then Edge (`msedge.exe`) on Windows.

| Export | What it is |
|---|---|
| `LAUNCH_TIMEOUT_MS` | `60_000` — the first answer's deadline per start. `launchTimeoutMs` defaults to the larger of this and `timeoutMs`; every later call has `timeoutMs` |
| `LAUNCH_ATTEMPTS` | `2` — an unanswered start is reaped and started once more on a fresh profile. Never more |
| `LAUNCH_BUDGET_MS` | derived: `LAUNCH_ATTEMPTS × (LAUNCH_TIMEOUT_MS + LAUNCH_REAP_MS)` — the longest a launch is designed to take, both starts and their bounded reaps |
| `E2E_BROWSER_OPEN_MS` | derived: `LAUNCH_BUDGET_MS` + the session's two setup calls + the first tab, at `DEFAULT_CDP_TIMEOUT_MS` each. THE deadline of every `beforeAll` that opens a browser — one below it is killed by Bun before the relaunch, and `X_CDP_LAUNCH_FAILED` never names the slow step |
| `LAUNCHED_CLOSE_MS` (`@ultimat3/scraping/cdp`; was `E2E_BROWSER_CLOSE_MS`) | derived: `4 × CLOSE_GRACE_MS` — SIGTERM's grace, SIGKILL's, the group reap, the profile's removal. THE deadline of an `afterAll` that closes a browser it holds (one that releases a lease takes `E2E_BROWSER_OPEN_MS`: it may await the open). At Bun's 5 s default a close cut short by the run's end left the profile half-removed in the temp root |
| `E2E_TAB_OPEN_MS` | derived: one more `session.newTab()` — `Target.createTarget`, then its attach |
| `E2E_GOTO_MS` | derived: one `tab.goto()` — the navigate raced by the load event, then two reads of the document |
| `E2E_APP_START_MS` | derived: `startE2eApp()` at its default deadline — `x db reset`, `x db seed` and `/readyz` (wall-clock), each its whole 90 s, then a refused boot's stop |
| `E2E_APP_STOP_MS` | derived: an e2e app's `stop()` — SIGTERM, the app's own drain at the defaults (readiness grace + `drain.deadlineMs`), then SIGKILL. Bounded: a wedged app no longer holds the hook forever |
| `CdpLaunchAttempt` | one unanswered start, in `X_CDP_LAUNCH_FAILED`'s `meta.attempts`: `why` (`deadline` \| `closed` \| `spawn` — the binary could not be started at all), `waitedMs`, `exitCode` (`null` when killed), `stderr` (its last lines), `detail` (what the launcher saw end it: the refused dial and its endpoint, the call that timed out, the spawn error) |
| `leaseE2eBrowser(key, open)` | ONE browser for every suite of the process that asks by `key`: `{ opened, release() }`, opened by the first, each suite its own tab. Closed by the last holder out — or, once a preload has called `closeE2eBrowsersAtRunEnd()`, at the run's end (Bun fires no `exit` under `bun test`, and runs one file to its end before loading the next) |
| `LaunchedBrowser.close()` · `E2eBrowser.close()` | THE close, a promise, always awaited: the process, its whole process group (on Windows its process tree, `taskkill /T /F`), and only then its profile directory — removed again while something re-creates it, bounded — and Chrome's `com.google.Chrome.XXXXXX` singleton-socket directory beside it, when it holds nothing but singleton files. There is no synchronous close |

Every hook that opens or closes a browser derives its deadline from these — the open, the close,
the app's start or stop, plus its own steps. `e2e-browser-hooks.test.ts` reads every suite under
`packages/*/e2e`, `examples/*/apps/*/e2e` and `dummy/*/apps/*/e2e`, follows each exported helper
that calls an opener (`acceptanceBrowser()`) or `startE2eApp`, resolves named deadlines through
their declarations, and refuses a literal, a missing deadline or a sum without the budget it needs.

`As of 2026-10-05`.

## The one assertion that waits

```ts
import { e2eTest, expect } from '@ultimat3/testing';

e2eTest('the feed paints, and says so when the socket drops', async ({ page }) => {
  // Retries isVisible() to a budget — 5000ms every 100ms unless you narrow it.
  await expect(page.getByRole('heading', { name: 'Feed' })).toBeVisible();
  await expect(page.getByText('Reconnecting')).toBeVisible({ timeout: 10_000 });

  // `.not` waits for it to GO, not for one look to come back false.
  await expect(page.getByText('Offline')).not.toBeVisible();
});
```

| Fact | Why |
|---|---|
| the budget is counted in **looks**, not elapsed ms | this package freezes `Date.now()`, so a deadline read off the clock never expires. `1 + floor(timeout / interval)` |
| a fixed interval, never a curve | the caller's deadline is the contract; a curve spends most of it waiting. The framework's one backoff curve is `@ultimat3/core`'s |
| `interval: 0` is refused | an unbounded spin is a test that never fails — it hangs, and CI reports a runner timeout with no assertion in it |
| a receiver with no `isVisible()` is `X_TEST_LOCATOR_EXPECTED` | the assertion is unanswerable, not false; `pass: false` would read as "the element was hidden" |
| `timeout: 0` is the non-retrying spelling | one look, no wait — and you have to ask for it |

`expect(await locator.isVisible()).toBe(true)` still works and is a **different** assertion: it
fails on a page that simply has not painted yet.

## Proving a subject erase

`subjectProof(subject, { entities, writer, read, seed? })` seeds every table with canaries
(`seedGraph`), erases one generated person through the erase's own table passes, and reads every
stored row back: a seeded value of theirs outside a declared `retain`, or a row the erase deletes
still stored, is `X_SUBJECT_ERASE_INCOMPLETE` naming the table and column. A declaration the plan
refuses comes back as its own problems, nothing seeded. `x exercise` runs it for every
`defineSubject()`, on a scratch database of its own.

## Errors

`X_TEST_NETWORK_SEALED` `X_TEST_DB_UNAVAILABLE` `X_TEST_NONDETERMINISTIC` `X_TEST_FIXTURE_UNKNOWN`
`X_TEST_APP_NOT_BOOTED` `X_TEST_FACTORY_TRAIT_UNKNOWN` `X_TEST_FACTORY_NOT_PERSISTED` `X_TEST_REGISTRY_LEAK`
`X_TEST_ISLAND_NOT_BUILT` `X_TEST_ISLAND_NO_MOUNT` `X_TEST_ISLAND_SELECTOR_UNSUPPORTED`
`X_TEST_ISLAND_STATES_EMPTY` `X_TEST_ISLAND_STATE_UNKNOWN`
`X_TEST_ISLAND_STATES_NOT_PURE` `X_TEST_ISLAND_STATES_MISSING_FILE` `X_TEST_ISLAND_STATES_UNKNOWN`
`X_TEST_ISLAND_STATES_AMBIGUOUS` `X_TEST_ISLAND_STATE_ID_INVALID` `X_TEST_ISLAND_STATE_DUPLICATE`
`X_TEST_ISLAND_STATE_JSON_INVALID` `X_TEST_ISLAND_STATE_CLOCK_INVALID`
`X_TEST_ISLAND_STATE_STUB_INVALID` `X_SEED_GRAPH_UNSATISFIED` `X_E2E_A11Y_VIOLATION`
`X_SEED_GRAPH_ENTITY_UNKNOWN` `X_TENANT_LEAK` `X_TENANT_WRITE_CROSSED` — the last two are findings
`x exercise` returns, never thrown

### Error classes

Every error class `src/index.ts` exports, for `instanceof` inside one process. Across a wire or
a job boundary the class is gone and the `code` is what survives — match on that.

| Class | Code | Declared in |
|---|---|---|
| `AppNotBootedError` | `X_TEST_APP_NOT_BOOTED` | `src/errors.ts` |
| `E2eA11yAllowUnreasonedError` | `X_E2E_A11Y_VIOLATION` | `src/e2e-a11y-run.ts` |
| `E2eA11yUnavailableError` | `X_TEST_FIXTURE_UNAVAILABLE` | `src/e2e-a11y-run.ts` |
| `E2eA11yViolationError` | `X_E2E_A11Y_VIOLATION` | `src/e2e-a11y-run.ts` |
| `FixtureUnavailableError` | `X_TEST_FIXTURE_UNAVAILABLE` | `src/errors.ts` |
| `NetworkOfflineError` | `X_TEST_NETWORK_OFFLINE` | `src/errors.ts` |
| `NetworkSealedError` | `X_TEST_NETWORK_SEALED` | `src/errors.ts` |
| `NondeterministicError` | `X_TEST_NONDETERMINISTIC` | `src/errors.ts` |
| `RegistryLeakError` | `X_TEST_REGISTRY_LEAK` | `src/errors.ts` |
| `SeedGraphUnsatisfiedError` | `X_SEED_GRAPH_UNSATISFIED` | `src/seed-graph-error.ts` |
| `TestDatabaseUnavailableError` | `X_TEST_DB_UNAVAILABLE` | `src/errors.ts` |

## Log lines under test

| `LOG_LEVEL` | The terminal shows | A `setLogSink` a test installs receives |
|---|---|---|
| unset | nothing — the reporter only | `info` and above |
| `info` | `info` and above | `info` and above |
| `debug` · `trace` | that level and above | that level and above — asking for more lines is asking for them everywhere |
| `warn` · `error` · `fatal` · `silent` | that level and above | **`info` and above, still** |

The last row is the rule: a level above `info` filters the TERMINAL, never the process logger.
Core reads `LOG_LEVEL` once, when it is first imported, so `LOG_LEVEL=error bun test` used to raise
the logger itself and a test asserting on an `info` audit line collected nothing. `quiet-logs.ts`
pins the level at `info` for the moment core loads, restores the variable (a spawned child inherits
what was named), and installs the filter. It is the preload's first import for that reason.
`As of 2026-10`.

## One process, one registry

`bun test` runs every file of one invocation in the same process — only `x verify`'s shards pass
`--isolate`. A file that leaves a process-global registry dirty therefore changes what every later
file sees, and the failure lands on an innocent suite in another package: `bun test ./packages/query/
./packages/cli/` failed five tests in `query`, all of them installed by `cli`, while either package
alone was green.

The preload installs the guard. It samples the cache tag set and the cache tier registry once per
file, at the end of that file's module evaluation — so an app's own boot declarations are its
environment — and reports what the file added after that and did not put back:

```text
X_TEST_REGISTRY_LEAK: a test file left a process-global registry dirty —
"packages/cli/src/cmd-dev.test.ts" left cache tags declared ["devfixture"] after its last test
  fix: in "packages/cli/src/cmd-dev.test.ts" add: import { isolateDeclaredTags } from
       '@ultimat3/cache'; const restoreTags = isolateDeclaredTags(); afterAll(restoreTags);
       — then re-run: bun test "./packages/cli/src/cmd-dev.test.ts"
```

The baseline is not a `beforeEach`: a file's own `beforeAll` runs **before** a preload's
`beforeEach` (onLoad → module eval → file `beforeAll` → describe `beforeAll` → preload
`beforeEach`, measured on Bun 1.3.14), so a `declareTags()` in `beforeAll` would have been sampled
as the file's environment and the run would have gone green. The guard appends the sample to the
file's own source in its load handler instead — the one place a file's identity and its evaluation
boundary are both known.

The fix is `isolateDeclaredTags()` or `isolateTiers()` (both `@ultimat3/cache`), never a loosened
assertion in the file that paid for it — and never a **reset**. A reset drops what a neighbour
registered, and this guard reports additions only, so the damage lands on an innocent file with
nothing pointing back. A leak fails a one-file run exactly as it fails the suite —
each file is judged against its own baseline — which is what makes the `bun test <file>` in the fix
line reproduce it.

### A module mock ends with its file

Bun keeps a `mock.module` (and its aliases `vi.mock`, `jest.mock`) for the life of the process,
past `mock.restore()` and past the file. The preload wraps the call: a file's first mock of a
module snapshots the real namespace, and the file boundary mocks it back, so the next file on a
shared worker reads the real module. A mock made in a preload is every file's environment and is
left alone. The cost: the real module is LOADED for its snapshot, so its top-level code runs. One
that throws on load cannot be put back; the next file's first test fails with the file named:

```text
X_TEST_MODULE_MOCK_UNRESTORABLE: a mocked module could not be put back at the file boundary —
"/app/a.test.ts" mocked "/app/vendor.ts", whose real module failed to load (…)
  fix: x test unit --isolate   # or hand the mocked dependency to the code under test as a parameter
```
