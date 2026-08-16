# @ultimat3/testing

The harness. Never mock the database — clone it. Never assert on wall-clock time — advance the
frozen clock. Never let a test reach the network unmocked — it fails by design.

## What it owns

| Module | Owns |
|---|---|
| `harness.ts` | `describeApp()` / `testApp()` — boot an app in-process with its own database |
| `template-db.ts` | N workers, N databases, one migrated template, `CREATE DATABASE ... TEMPLATE` |
| `determinism.ts` | frozen clock, seeded RNG, seeded uuids, `assertDeterministic` |
| `sealed-network.ts` | any unmocked egress fails, with the URL and the mock line |
| `factories.ts` | `defineFactory` — seeded rows, traits, associations, `build` vs `create` |
| `factory-registry.ts` | `factoriesFor(registry)` — one factory per entity, defaults read off column names |
| `factory-persist.ts` | `usePersister` — the one seam `create()` writes through |
| `shared-examples.ts` | `sharedExamples` / `behavesLike` — one rule, many subjects |
| `test-types.ts` | the six test types and their helpers |
| `matchers.ts` | `toBeUltimateError` `toDenyPolicy` `toEmitSteps` `toMatchOpenApi` `toBeWithinBudget` `toRejectInput` |
| `fixtures.ts` | the registry + `test('…', ({ clock }) => …)` injection |
| `fixture-{clock,mail,jobs,network,statements}.ts` | the five fixtures the framework builds in-process |
| `fixture-drivers.ts` | the five it declares but a driver must build — `page` `budget` `signIn` `deploy` `subscribe` |
| `framework-fixtures.ts` | registers both sets; the app registers only what it owns |
| `registry-leak-guard.ts` | fails the run naming the FILE that left a process-global registry dirty |
| `registry-isolation.ts` | `isolateEntityRegistry()` — an empty entity registry, and the process's back after. Its own entry point (`@ultimat3/testing/registry-isolation`), never the barrel: it value-imports `@ultimat3/entity`, and the barrel is what a tier-0 test imports for `expect` |
| `preload.ts` | the bunfig preload that installs all of the above |

## Install

```toml
# bunfig.toml
[test]
preload = ["@ultimat3/testing/preload"]
```

## Fixtures

`test` from this package passes a fixture bag as the first argument, and builds only what the
body destructures — a test that never names `runJobs` never starts a queue.

```ts
import { expect, test } from '@ultimat3/testing';

test('the three-day sleep releases the worker', async ({ clock, runJobs }) => {
  await runJobs(onboardOrg, { orgId });
  expect(await runJobs.inFlight()).toBe(0);   // suspended, not waiting
  clock.advance('3d');
  expect(await runJobs.due()).toBe(1);
});
```

| Fixture | Is | Built by |
|---|---|---|
| `clock` | `now()` · `advance('3d')` · `set(instant)` on the frozen clock | the preload |
| `mail` | `outbox()` · `lastTo(address)` · `failOnce(mail)` over an in-memory transport | the preload |
| `network` | `offline()` · `drop()` · `online()` · `state()` over the sealed network | the preload |
| `runJobs` | a worker: call it to enqueue+drain, then `drain()` `due()` `inFlight()` `depth()` | the preload |
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
| `e2eTest` | a browser driver incl. offline mode + SW update; with none registered it SKIPS, and the gate's `e2e` step passes over the skip — ask `hasE2eDriver()` rather than reading that as a pass | `e2e` |
| `evalTest` | LLM output scoring against a threshold | `eval` |

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
    await expect(subject().call(input, { actor: anonymous })).toDenyPolicy();
  });
});

describe('publishPost', () => behavesLike(anAuthenticatedAction, () => publishPost));
```

The subject is a function, not a value, for the reason `describeApp`'s accessor is: the block is
declared at module scope and the subject often does not exist until `beforeAll` has run. The
failure line reads `publishPost > behaves like an authenticated action > denies an anonymous actor`
— which subject, and which shared rule. `behavesLike` calls `describe`, so it goes at declaration
scope, never inside a test body.

## Parallel databases

```ts
const db = await acquireWorkerDatabase({ adminUrl, migrate });
```

The first worker creates the template under a Postgres advisory lock and migrates it once; every
worker then clones it copy-on-write. With no Postgres configured it falls back to PGlite, so
`bun test` works on a laptop with nothing installed.

**The gate shards; a bare `bun test` does not.** `As of 2026-08`:

| Command | Processes | Worker ids | Databases |
|---|---|---|---|
| `bun test` (what a scaffolded app's `test` script still runs) | 1 | `0` | one |
| `x verify` (`unit`, `contract`, `job`, `eval`; `live` and `e2e` stay serial) | `clamp(round(cpus * 1.5), 2, 8)` | `0..N-1`, from `ULTIMATE_TEST_WORKER` | N |
| `bun test --parallel[=N]` | N (default: CPU count) | `1..N`, from Bun's own `BUN_TEST_WORKER_ID` | N |
| `x test --workers N` | N | `0..N-1`, from `ULTIMATE_TEST_WORKER` | N |

`ULTIMATE_TEST_WORKER` is read first so a runner-assigned shard always beats the index Bun assigns
its own `--parallel` worker — measured on Bun 1.3.14, `--parallel` populates `BUN_TEST_WORKER_ID`
and `JEST_WORKER_ID` itself, so that precedence is load-bearing rather than defensive.

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

## Errors

`X_TEST_NETWORK_SEALED` `X_TEST_DB_UNAVAILABLE` `X_TEST_NONDETERMINISTIC` `X_TEST_FIXTURE_UNKNOWN`
`X_TEST_FACTORY_TRAIT_UNKNOWN` `X_TEST_FACTORY_NOT_PERSISTED` `X_TEST_REGISTRY_LEAK`

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

The fix is `isolateDeclaredTags()` (`@ultimat3/cache`) or `afterAll(resetTiers)`, never a loosened
assertion in the file that paid for it. A leak fails a one-file run exactly as it fails the suite —
each file is judged against its own baseline — which is what makes the `bun test <file>` in the fix
line reproduce it.
