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
| `fixture-island.ts` | `mountIsland()` — build an island, import its chunk, run its `mount`. The BUILDER is a parameter |
| `island-dom.ts` | the micro-DOM `mountIsland` drives: what compiled Solid touches, and nothing else |
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

## The harness puts back what it found

`bun test` is one process, so `describeApp`/`testApp` teardown is a **restore**, never an uninstall.
`As of 2026-08`:

| State | Owned by | What teardown does |
|---|---|---|
| the seal on `fetch` | the preload | unseals only if this boot was the one that sealed |
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

**A mount installs process-global state**, so `MountedIsland` is `Disposable` — `using`, or
`island[Symbol.dispose]()` in an `afterAll`. Left installed it hands a fake `document` to every
later FILE in the run.

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

**The command that takes the pictures is not here yet.** `As of 2026-08-23` this package ships the
vocabulary, the expansion and the refusals; the browser half is `x shot`'s.

## Errors

`X_TEST_NETWORK_SEALED` `X_TEST_DB_UNAVAILABLE` `X_TEST_NONDETERMINISTIC` `X_TEST_FIXTURE_UNKNOWN`
`X_TEST_FACTORY_TRAIT_UNKNOWN` `X_TEST_FACTORY_NOT_PERSISTED` `X_TEST_REGISTRY_LEAK`
`X_TEST_ISLAND_NOT_BUILT` `X_TEST_ISLAND_NO_MOUNT` `X_TEST_ISLAND_STATES_EMPTY`
`X_TEST_ISLAND_STATES_NOT_PURE` `X_TEST_ISLAND_STATES_MISSING_FILE` `X_TEST_ISLAND_STATES_UNKNOWN`
`X_TEST_ISLAND_STATES_AMBIGUOUS` `X_TEST_ISLAND_STATE_ID_INVALID` `X_TEST_ISLAND_STATE_DUPLICATE`
`X_TEST_ISLAND_STATE_JSON_INVALID` `X_TEST_ISLAND_STATE_CLOCK_INVALID`
`X_TEST_ISLAND_STATE_STUB_INVALID`

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
