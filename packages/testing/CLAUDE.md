# @ultimat3/testing — boundary

Tier 5. May import tiers 0–4. Imported by every package's tests and by generated apps.

Deps: `core` (tier 0), plus `time`, `jobs`, `mail`, `db` and `entity` — imported **dynamically
inside the fixture factories only**, so a test that never destructures `mail` never loads the mail
package and a `packages/core` test never loads the entity registry. `entity` is a dependency for
exactly one call: `nPlusOne()`, so the strict fixture reports the error `x dev` reports, with the
`fix:` the schema's own relations spell. A second N+1 code owned here would be a second answer to
one condition. The one static `entity` import is `registry-isolation.ts`, which is why that module
is its own entry point and not part of the barrel.

| Rule | Detail |
|---|---|
| No mocks of the DB | clone a template database; `template-db.ts` is the only DB path |
| No wall clock | `frozenClock` / `advanceClock`; `Date.now()` is frozen by the preload |
| Frozen ≠ different | `globalThis.Date` becomes a subclass, so `FrozenDate[Symbol.hasInstance]` brands on the `[[DateValue]]` slot — `Date.prototype.getTime.call(value)` throws or it doesn't. Without it `value instanceof Date` is false for every Date the runtime built itself — a `timestamptz` off a Postgres socket, a `structuredClone`, anything from another realm — and the guards that read it fail under test and nowhere else |
| Slot, not prototype | the brand is cross-realm on purpose: `instanceof RealDate` misses a `node:vm` or worker Date, and `Object.prototype.toString` is spoofable by `Symbol.toStringTag: 'Date'`. Only the slot is both |
| No unmocked egress | `sealed-network.ts` patches fetch; a miss is `X_TEST_NETWORK_SEALED` |
| Self is not egress | a port core's `markListening()` announced passes through — a socket test never unseals |
| Offline is a state, not a mock | `network.offline()` / `.drop()` fail every request as `X_TEST_NETWORK_OFFLINE`, ahead of the mocks — the app's own offline path runs |
| One way offline | the `network` fixture. `setNetworkState` is the gate's only writer and is not exported — setting it from a test body skips the fixture's disposal and leaves every later file offline |
| No retries | a flake is fixed or deleted the day it flakes; there is no `retry: 3` |
| Test names | the filename picks the step; `testName(type, name)` on the outer `describe` puts that type on every failure line under it. Never on the inner `test` too — the prefix would print twice |
| Injection | `SqlRunner` and `connect` are parameters, so unit tests need no server |
| Fixtures | the preload registers the whole framework bag — an app registers only what the framework cannot know (`seed`, `actorFor`) |
| e2e without a driver | `e2eTest` becomes `test.skip`, and the gate reports the step GREEN over it — `bun test` exits 0 on a skip and the exit code is the only channel between the step and the child that registers the driver. `hasE2eDriver()` is what a harness asks instead of reading an all-skipped run as a pass. Zero drivers are registered `As of 2026-08` |
| Built vs declared | `clock` `mail` `network` `runJobs` `statements` are built in-process; `page` `budget` `signIn` `deploy` `subscribe` are declared and wait for a driver (`X_TEST_FIXTURE_UNAVAILABLE`) |
| Strict is opt-in by destructuring | `statements` installs the N+1 detector in throw mode for one test. A fixture nobody names is a fixture nobody built, so there is no `strict: true` and no suite-wide switch — and no way to leave it on for the next file |
| One threshold, one error | `N_PLUS_ONE_THRESHOLD` and `nPlusOne()` are `@ultimat3/entity`'s. A number or a message written here would make a loop that fails a test a different loop from the one `x dev` warns about |
| The unit of work is the test | `x dev`'s ledger tallies per `Ctx` and ignores a statement issued outside a request; this counts every statement from build to disposal, because `posts.findById(id)` in a unit test has no request and is exactly the loop worth catching |
| Throws once per shape | the failing line is the loop's own statement (the seam lets `onStatement` throw for this reason alone). It keeps counting after, so a body that catches the error still reports the whole loop through `shapes()` — the same hole Bullet's `raise` has, named rather than papered over |
| Measure vs judge | `all()` `count()` `shapes()` count `expectedQueryLoop` statements too; only the verdict honours the suppression, so "this page issues two statements" never depends on who declared what |
| One seam for drivers | a driver registers over a declaration with `defineFixtures` — merges, last wins. Never a second registration mechanism |
| A driver arrives whole | `defineFixtures` holds every name `Fixtures` declares to its declared type, so a half-built `page` is a compile error at the registration, not a missing method three awaits later |
| Registry hygiene | the fixture registry is process-global; a test that clears it snapshots with `fixtureSnapshot()` and hands it back in `afterAll` |
| Leaks are the file's, not the next file's | `installRegistryLeakGuard()` runs from the preload and fails the run naming the FILE that left cache tags declared or a cache tier registered after its last test (`X_TEST_REGISTRY_LEAK`). `bun test` is one process, so without it the failure lands on an innocent suite in another package. What a file's MODULE graph declares is its environment; what the file installs after that is its own to undo |
| The baseline is not a hook | measured on Bun 1.3.14 the order is onLoad → module eval → file `beforeAll` → describe `beforeAll` → preload `beforeEach`, so a preload hook cannot sample before the file's own `beforeAll` — a `declareTags()` there read as environment and the run went green. The load handler appends the sample to the file's source instead: after evaluation, before any hook the file registers. It is also the only signal carrying file identity, which `bun:test` hooks do not |
| Guarded state is boot state | only the two registries whose honest invariant is "clean when the file ends" — `declareTags` and `registerTier` are boot installs. `entity()`, `job()` and `defineRoute()` register at MODULE scope, which is how an app declares itself, so a filled registry there is idiomatic and unguarded |
| An empty registry is a premise you state | a test whose subject is "nothing is declared" — `x db gen` with nothing to generate — calls `isolateEntityRegistry()` and restores in a `finally`. Inheriting it means the test passes until a neighbouring file imports an entity |
| That one helper is off the barrel | `@ultimat3/testing/registry-isolation`, its own entry point. It is the only module here that value-imports `@ultimat3/entity` — the restore is handed back synchronously, so it cannot be a dynamic import inside the call — and a static re-export from `src/index.ts` would load the entity registry into every test that imports this package for `expect` |
| Teardown restores, never uninstalls | `describeApp`/`testApp` capture the seal and the determinism snapshot before booting and put those back — `restoreDeterminism()` in a scope hands the REAL clock and the REAL `fetch` to every later FILE in the process. `captureDeterminism()` / `restoreCapturedDeterminism()` are the pair for any nested install |
| Teardown is a `finally` | an `app.close()` that rejects still reaches `db.drop()` and still restores the process state; the first failure is what the caller sees. A stranded clone is one `ultimate_test_template_wN` leaked per failing run |
| A found template is not a migrated one | `template-db.ts` tolerates "already exists" for the `CREATE DATABASE` alone. `config.migrate` runs unconditionally and un-swallowed — on any Postgres that outlives one run the template is found, not created, and skipping it clones the first run's schema forever |
| Fixture teardown | a fixture that installs process-global state (the ambient job or mail driver) implements `Symbol.dispose` / `Symbol.asyncDispose` and restores what was there; `fixtureTest` disposes in reverse build order even when the body throws |
| Building one by hand | `createRunJobs()` outside `fixtureTest` is not disposed for you — reset the driver in `afterEach`, or the next file in the process inherits your queue |
| Factory strategy | an association is built with the strategy that asked for it: `build()` never reaches a database, `create()` writes the parent first. Never a third strategy |
| One write seam | `usePersister` is the only place `create()` writes. A factory that took a repo argument would put the seam at every call site |
| Factory seeds | derived from the table name unless given, so two entities never draw the same uuid stream. `reset()` cascades into associated parents — a half-reset row is worse than none |
| Shared examples | `behavesLike` calls `describe`, so it goes at declaration scope; bun rejects a `describe` inside a test body |
| Which command shards | `bun test` is one process on one database, and that is still what a scaffolded app's `test` script runs. `x verify` DOES shard its parallel test steps, over `ULTIMATE_TEST_WORKER` and one database per worker; `live` and `e2e` stay serial because a replication slot is cluster-scoped and `e2e` has one built `dist/`. Say which command a claim is about |

Commands: `bun test`, `bunx tsc --noEmit -p tsconfig.json`.

Entry points: `.` (the API), `./preload` (side effects for bunfig) and `./registry-isolation`
(`isolateEntityRegistry()`, kept off `.` because it loads `@ultimat3/entity`).
