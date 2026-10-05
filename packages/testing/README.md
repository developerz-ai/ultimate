# @ultimat3/testing

The harness. Never mock the database — clone it. Never assert on wall-clock time — advance the
frozen clock. Never let a test reach the network unmocked — it fails by design.

## What it owns

| Module | Owns |
|---|---|
| `harness.ts` | `describeApp()` / `testApp()` — boot an app in-process with its own database |
| `template-db.ts` | N workers, N databases, one migrated template, `CREATE DATABASE ... TEMPLATE` |
| `determinism.ts` | frozen clock, seeded RNG, seeded uuids, `assertDeterministic` |
| `sealed-network.ts` | any unmocked `fetch`, `WebSocket` or `Bun.connect` egress fails, with the URL and the line that fixes it |
| `sealed-sockets.ts` | the `WebSocket` and `Bun.connect` patches, behind `sealed-network.ts`'s one gate |
| `factories.ts` | `defineFactory` — seeded rows, traits, associations, `build` vs `create` |
| `factory-registry.ts` | `factoriesFor(registry)` — one factory per entity, defaults read off column names |
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
| `registry-snapshot.ts` | `captureProcessRegistries()` / `restoreProcessRegistries()` — the locale config, the catalogs, the permission set and the role map, put back as a file inherited them. A module-scope declaration evaluates once per process (`bun test` without `--isolate`, `As of 2026-08`), so a neighbour's `clearPermissions()` is otherwise permanent |
| `registry-isolation.ts` | `isolateEntityRegistry()` — an empty entity registry, and the process's back after. Its own entry point (`@ultimat3/testing/registry-isolation`), never the barrel: it value-imports `@ultimat3/entity`, and the barrel is what a tier-0 test imports for `expect` |
| `quiet-logs.ts` | a green run prints the reporter and nothing else: the framework's log lines go to a sink that drops them. `LOG_LEVEL=info bun test <file>` shows them — naming `LOG_LEVEL` is the one escape hatch, and a level above `info` filters what the TERMINAL shows, never what the logger emits (below). A test asserting on log output hands `createLogger({ level, writer })` its own writer, or installs its own `setLogSink` and restores the previous one |
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
| `runJobs` | a worker: call it to enqueue+drain, then `enqueue()` `drain()` `due()` `inFlight()` `depth()` — see [below](#a-job-under-runjobs) | the preload |
| `statements` | every statement the test issued: `all()` `count(fingerprint?)` `shapes()` — and an N+1 throws | the preload |
| `page` | the browser: `goto` `gotoStreamed` `getByRole` `evaluate` `waitForServiceWorker` | a browser driver |
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
| **a real worker's pass** | each round is `createWorker(...).tick()`: admission, the limiter and keyed `concurrency` (`whenBusy: 'fail'` settles `refused`, `X_JOB_KEY_BUSY`) hold exactly as in production |
| **a cancel reaches a running body** | the worker renews its lease on the TEST clock — every millisecond of it — and a renewal that misses the row aborts `ctx.signal` with `X_JOB_LEASE_LOST`: start `runJobs.drain()`, cancel the row (`cancelJob(jobDriver(), id)` or the app's own action), `clock.advance(1)`, await the drain. No hand-built worker, no sleep, no wall-clock timer |

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

Opting in is naming it. `statements` installs `@ultimat3/db`'s statement observer for the length of
one test and hands the seam back afterwards, so there is no `strict: true` to remember and no
suite-wide switch to forget.

| | |
|---|---|
| **the unit of work is the test** | `x dev`'s ledger counts per request and skips a statement issued outside one; a unit test calling `posts.findById(id)` has no request anywhere, and that is the loop it was written to catch |
| **one threshold** | `N_PLUS_ONE_THRESHOLD` from `@ultimat3/entity`, the number `x dev` warns at. A loop that fails a test and a loop that warns in dev are the same loop |
| **one error** | `nPlusOne()`'s, so the `fix:` is the `preload()` the schema's own relations spell — never a line this package composes |
| **it throws where it happened** | the loop's fifth statement rejects, so the failing line is the loop's own. Once per shape: a body that catches it gets one failure, not one per statement after it |
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
| `e2eTest` | a browser driver; with none registered it SKIPS, and the gate's `e2e` step passes over the skip — ask `hasE2eDriver()` rather than reading that as a pass | `e2e` |
| `evalTest` | LLM output scoring against a threshold | `eval` |

Each takes an optional `{ timeoutMs }` after the body — `unitTest(name, body, { timeoutMs: 30_000 })`,
and `test` takes the same; `evalTest` reads it off its options — handed to `bun:test` as that
test's own deadline (`TestOptions`). Absent is Bun's 5 s default. An `E2eDriver` receives it as its
third argument. `unitTest`, `contractTest`, `liveTest` and `jobTest` hand their body the
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
const orgs = defineFactory(orgEntity, {
  defaults: (n, ids): Org => ({ id: ids.uuid(), name: `org-${n}` }),
});

const posts = defineFactory(postEntity, {
  defaults: (n, ids): Post => ({ id: ids.uuid(), title: `post-${n}`, orgId: '', published: false }),
  traits: { published: { published: true }, popular: (n) => ({ views: n * 100 }) },
  associations: { orgId: associate(orgs, (org) => org.id) },
});

posts.with('published').build();          // in memory, org built alongside it, no database
await posts.with('published').create();   // org written first, then the post
```

| | |
|---|---|
| **trait** | a named partial. `with('a', 'b')` composes left to right; an explicit override still wins |
| **association** | a column whose value comes from another factory, built with the **same strategy** — `build` leaves the parent in memory, `create` writes it |
| **overrides suppress associations** | a column the caller (or a trait) supplied never creates a parent row nobody asked for |
| **`build` vs `create`** | `build` never touches a database; `create` writes through `usePersister` and fails as `X_TEST_FACTORY_NOT_PERSISTED` when nothing installed one |
| **seeded per table** | the default seed is derived from the table name, so a post and an org never draw the same uuid. Pass `seed` only to replay an older recording |
| **`with()` validates** | an undeclared trait fails at the line that named it, listing the declared ones (`X_TEST_FACTORY_TRAIT_UNKNOWN`) |

`factoriesFor(registry)` builds one factory per registered entity, with values inferred from column
names (`…Id` → uuid, `…At` → date, `…Minor` → integer, `is…`/`has…` → false). Enough for the rows a
test does not care about; `defineFactory` is for the rows it does.

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

Two ship, for the ports an app may implement itself — a `JobDriver` and `@ultimat3/ai`'s
`BudgetStore`:

```ts
import { MemoryBudgetStore } from '@ultimat3/ai';
import { createMemoryDriver } from '@ultimat3/jobs';
import { behavesLike, budgetStoreConformance, describe, jobDriverConformance } from '@ultimat3/testing';

// The shipped ports pass; put your own driver or store where these are.
describe('my queue', () => behavesLike(jobDriverConformance, () => createMemoryDriver()));
describe('my budget store', () => behavesLike(budgetStoreConformance, () => new MemoryBudgetStore()));
```

| Suite | Holds a store to |
|---|---|
| `jobDriverConformance` | claim once · ack/nack fenced on the claim · a live key dedupes · `queues: []` refused · dead-letter never re-claimed · a lapsed lease re-claimed, the loser unable to renew · a lease lapsed on the final attempt buried, reported through `onExhausted` once, `failed` under `dropExhausted` |
| `budgetStoreConformance` | 24 concurrent `take`s on one key never overspend · a refused take spends nothing · negative `add` · `reset(key)` scoped |

The subject is called once per test. Each check claims from a queue — or counts under a key — of
its own, so one shared store is enough.

## Parallel databases

```ts
const db = await acquireWorkerDatabase({ adminUrl, migrate });
```

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

A server this process booted is exempt: `createServer().start()` announces its socket through
core's `markListening()`, so a test may call its own `handle.url()` on a kernel-assigned port with
the seal fully on. Unsealing (`ULTIMATE_TEST_ALLOW_NET=1`) stays reserved for a deliberate live
integration — never for a socket test.

**Three dials are sealed, and only three** — `fetch`, `new WebSocket(url)` and `Bun.connect({ hostname,
port })`, behind one gate: one allow-list (`allowHost('host[:port]')`), one offline state, one
`requestedUrls()` record. As of 2026-10:

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
| **`actor`** | `load` and the page run inside `runWithContext(createContext({ actor }))`. Without one they run outside any request context, as a static page does |
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
| `CdpLaunchAttempt` | one unanswered start, in `X_CDP_LAUNCH_FAILED`'s `meta.attempts`: `why` (`deadline` \| `closed`), `waitedMs`, `exitCode` (`null` when killed), `stderr` (its last lines) |
| `LaunchedBrowser.close()` · `E2eBrowser.close()` | THE close, a promise, always awaited: the process, its whole process group (on Windows its process tree, `taskkill /T /F`), its profile directory. There is no synchronous close |

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

## Errors

`X_TEST_NETWORK_SEALED` `X_TEST_DB_UNAVAILABLE` `X_TEST_NONDETERMINISTIC` `X_TEST_FIXTURE_UNKNOWN`
`X_TEST_APP_NOT_BOOTED` `X_TEST_FACTORY_TRAIT_UNKNOWN` `X_TEST_FACTORY_NOT_PERSISTED` `X_TEST_REGISTRY_LEAK`
`X_TEST_ISLAND_NOT_BUILT` `X_TEST_ISLAND_NO_MOUNT` `X_TEST_ISLAND_SELECTOR_UNSUPPORTED`
`X_TEST_ISLAND_STATES_EMPTY` `X_TEST_ISLAND_STATE_UNKNOWN`
`X_TEST_ISLAND_STATES_NOT_PURE` `X_TEST_ISLAND_STATES_MISSING_FILE` `X_TEST_ISLAND_STATES_UNKNOWN`
`X_TEST_ISLAND_STATES_AMBIGUOUS` `X_TEST_ISLAND_STATE_ID_INVALID` `X_TEST_ISLAND_STATE_DUPLICATE`
`X_TEST_ISLAND_STATE_JSON_INVALID` `X_TEST_ISLAND_STATE_CLOCK_INVALID`
`X_TEST_ISLAND_STATE_STUB_INVALID`

### Error classes

Every error class `src/index.ts` exports, for `instanceof` inside one process. Across a wire or
a job boundary the class is gone and the `code` is what survives — match on that.

| Class | Code | Declared in |
|---|---|---|
| `AppNotBootedError` | `X_TEST_APP_NOT_BOOTED` | `src/errors.ts` |
| `FixtureUnavailableError` | `X_TEST_FIXTURE_UNAVAILABLE` | `src/errors.ts` |
| `NetworkOfflineError` | `X_TEST_NETWORK_OFFLINE` | `src/errors.ts` |
| `NetworkSealedError` | `X_TEST_NETWORK_SEALED` | `src/errors.ts` |
| `NondeterministicError` | `X_TEST_NONDETERMINISTIC` | `src/errors.ts` |
| `RegistryLeakError` | `X_TEST_REGISTRY_LEAK` | `src/errors.ts` |
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
file sees, and the failure lands on an innocent suite in another package: `bun test packages/query
packages/cli` failed five tests in `query`, all of them installed by `cli`, while either package
alone was green.

The preload installs the guard. It samples the cache tag set and the cache tier registry once per
file, at the end of that file's module evaluation — so an app's own boot declarations are its
environment — and reports what the file added after that and did not put back:

```text
X_TEST_REGISTRY_LEAK: a test file left a process-global registry dirty —
"packages/cli/src/cmd-dev.test.ts" left cache tags declared ["devfixture"] after its last test
  fix: in "packages/cli/src/cmd-dev.test.ts" add: import { isolateDeclaredTags } from
       '@ultimat3/cache'; const restoreTags = isolateDeclaredTags(); afterAll(restoreTags);
       — then re-run: bun test "packages/cli/src/cmd-dev.test.ts"
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
