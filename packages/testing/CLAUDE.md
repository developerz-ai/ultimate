# @ultimat3/testing — boundary

Tier 5. May import tiers 0–4. Imported by every package's tests and by generated apps.
A row marked `†` has its full text in [`docs/history/testing-rules.md`](../../docs/history/testing-rules.md).

Deps (21): `core` `schema`; `cache` `db` `i18n` `seo` `time`; `auth` `entity` `http` `policy`; `action`
`jobs` `query` `realtime`; `ai` `mail` `notify` `pwa` `render` `scraping` (`ai`, `auth`, `notify`, `scraping` for `swapAdapter`, dynamic-only). Static in `.`: `scraping/cdp`, `cache`
(`registry-leak-guard.ts:7`), `i18n`, `jobs`, `policy` (`registry-snapshot.ts:29-38`), `db`
(`reusable-database.ts:20`), `realtime/server` (`fixture-subscribe.ts:13`). Dynamic-only:
`action`, `http`, `mail`, `pwa`, `query`, `render`, `schema` (`exercise-input.ts:16`), `time` — no `mail` destructure, no mail
package; a `packages/core` import never loads `@ultimat3/entity`. `entity` is reached by `await import` only
(seed writer, tenant witness, `nPlusOne()`, repro, subject proof, the row observer); static only in
the off-barrel entry points `registry-isolation.ts`, `conformance.ts`. Full rule: `docs/history/testing.md`.

| Rule | Detail |
|---|---|
| No mocks of the DB | clone a template database; `template-db.ts` is the only DB path |
| No wall clock | `withFrozenClock` / `advanceClock`; `Date.now()` is frozen by the preload |
| Frozen ≠ different | `globalThis.Date` becomes a subclass; `FrozenDate[Symbol.hasInstance]` brands on the `[[DateValue]]` slot (`Date.prototype.getTime.call(value)` throws or not) |
| No unmocked egress | `sealed-network.ts` seals `fetch`; `sealed-sockets.ts` `WebSocket`, `Bun.connect`, `node:*`, UDP (not loopback); `sealed-dns*.ts` every resolver, named imports too (wiki `Testing.md`); a miss is `X_TEST_NETWORK_SEALED` |
| One `mockFetch`, and it grows | verbs, ordered answers, pinned dials (`mock-route.ts`), `requestLog` (`request-log.ts`) — one `mockFetch` † |
| Self is not egress | a port core's `markListening()` announced passes through — a socket test never unseals |
| Offline is a state, not a mock | `network.offline()` / `.drop()` fail every dial, loopback too, as `X_TEST_NETWORK_OFFLINE` before any mock: the app's offline path runs |
| One way offline | the `network` fixture. `setNetworkState` is the gate's only writer and is not exported — setting it from a test body skips the fixture's disposal and leaves every later file offline |
| The seal key is a test process's, and nobody's export | `test-seal-key.ts`: installed by the preload only when `NODE_ENV === 'test'` and neither `ULTIMATE_SECRETS_KEY` nor `.secrets.key` exists. Full rule: `docs/history/testing.md` |
| `toEqualRow` never prints a server-only value | `matcher-row.ts` compares every OWN property (`toEqual` cannot see a `.sealed()` column — empty diff). Full rule: `docs/history/testing.md` |
| No retries | a flake is fixed or deleted the day it flakes; there is no `retry: 3` |
| A mutator's `local()` runs against `memoryLocalTx()` | `local-tx.ts`: keyed rows with the record store's rules (update invents nothing, `undefined` leaves a column, rows frozen). Never a hand-rolled table per test |
| A page test RENDERS, with no cast | `renderRoute(module, { url, actor })` / `renderView(Component, props)` (`render-view.ts`) † |
| `toBeUltimateError` reads THREE fields | an `X_` code plus a `cause` plus a `fix`, all through core's `stringField`. `typeof value.code === 'string'` alone passed a Node `ENOENT` |
| One matcher WAITS, and it is `toBeVisible` | `await expect(locator).toBeVisible()` retries `isVisible()` to a budget — 5000ms every 100ms, Playwright's own default, narrowable per call. |
| The budget is counted in LOOKS, at a FIXED interval | `attemptsFor(budget)` is `1 + floor(timeout / interval)`; never a clock deadline, never a curve. Full rule: `docs/history/testing.md` |
| A Worker-backed promise is settled by hand, never `expect(p).rejects`/`.resolves` | Bun 1.4.4: once a test has awaited one Worker reply, those matchers wait for the next one without ever delivering it, and the file hangs until killed (an image transform runs on core's raster Worker). `expect(await p.then(() => 'passed', () => 'refused')).toBe('refused')`; repro and fix: `image-transform-conformance.test.ts` |
| A matcher that may throw a coded error MUST NOT be `async` | bun REPLACES an `async` matcher's thrown error with `returned a promise that rejected`, so code, cause and fix are gone. Full rule: `docs/history/testing.md` |
| Wrong receiver throws, wrong value returns | a wrong-shaped receiver is a coded throw, never `pass: false` |
| A matcher MESSAGE is a thunk, and never `JSON.stringify` | `result(pass, () => …)`. Full rule: `docs/history/testing.md` |
| Every message thunk needs a test that PROVOKES it | a thunk is a function, so an unread message is an UNCOVERED function and `bun run scripts/coverage-gate.ts --package testing` is what says so |
| Test names | the filename picks the step; a typed helper prefixes its own name. `testName(type, name)` is for an outer `describe` only — never on the inner `test` too, the prefix would print twice |
| One body shape, five registrars | `test` (= `fixtureTest`), `unitTest`, `contractTest`, `liveTest`, `jobTest` all take `FixtureBody` + `{ timeoutMs }`: `unitTest('…', async ({ runJobs }) => …)`. Never `describe(testName('unit', …))` + `test` to get a fixture |
| `runJobs` says who and what | `{ actor }` is the WORKER, `{ tenantId }` the enqueuer; bodies on the frozen clock † |
| A `runJobs` pass is a real worker's `tick()` | `fixture-jobs.ts`: an unstarted `jobWorker` per pass, so admission runs as in a fleet † |
| One test double per need | `stub(action \| llm() \| query \| job)` replaces the BODY only; `swapAdapter(port, impl)` borrows a port's installer; both undone by `test-scope.ts` † |
| A port is swappable or says why not | `swap-adapter.ts`: `BINDINGS` + `UNSWAPPED` cover `ADAPTER_PORTS` as a `Record` — a new core row is a compile error here |
| `toHaveBeenCalledWith` is bun's name | on a `stub()` it parses the expected input by the primitive's schema (`X_TEST_EXPECTED_INPUT_INVALID`); any other receiver goes to bun's own matcher, captured once (`matcher-stub.ts`) |
| Per-test state is `per-test-reset.ts` | the app preload's `beforeEach`; `installPerTestReset` installs the test-double scope † |
| A file reruns in one process | `rerun-declarations.ts`: what the file declared (body, hooks, tests) is forgotten as it loads again; a new registry joins `rerun-registries.ts` with its package's lister + exact restore, never a `reset*` |
| A `mock.module` ends with its file | `module-mock-boundary.ts` restores the real namespace at the boundary (`X_TEST_MODULE_MOCK_UNRESTORABLE`) † |
| **The frozen clock is reset at every file boundary** | `preload.ts`, `clock-file-boundary.test.ts`: `advanceClock` / `setFrozenClock` move one process-wide instant, and a file that left it moved handed the next file on its worker a different `Date.now()` |
| An island test is `describeIslandState` | one block per declared state: mounted in `beforeAll` (60 s), disposed in `afterAll`, one build per file. `mountIslandState` + `using` for one test's own mount; an undeclared id is `X_TEST_ISLAND_STATE_UNKNOWN` |
| An authenticator is tested with `authRequest()` | the hook's own two arguments, real — never `as unknown as Parameters<…>` |
| `LOG_LEVEL` above `info` filters the TERMINAL | `quiet-logs.ts` pins the logger at `info` while core loads, so a collecting `installLogSink` still sees `warn` under `LOG_LEVEL=error`. It stays the preload's FIRST import |
| Injection | `SqlRunner` and `connect` are parameters, so unit tests need no server |
| Fixtures | the preload registers the framework bag — an app registers only what it alone knows: `seed` as `seedFixture({ seeds, driver })` (`fixture-seed.ts`: once per test per name, rows captured on the way in, picked by label), `actorFor` |
| Every `e2eTest` is audited | `e2e-a11y*.ts`, `ax-node.ts`; no switch, `allow` needs a `because` † |
| The exercise pass runs what is registered | `exercise.ts` (`runExercisePass`): every action, query, job once, own tenant pair; overrides only via `defineExercise` † |
| A route `load` is exercised like a read | `exercise-route-loads.ts`: after the primitives, own tenant pair, swept and planned with them; its record is `RouteLoadRecord`, never in `records`; the crash proof's runs pace on the frozen clock (`exercise-crash.ts`) |
| An override `input` is awaited, as the call's actor | `exercise-override-input.ts`: inside the call's own request — the one way to a signed input † |
| A passkey test signs for real | `softAuthenticator` is `@ultimat3/auth/soft-authenticator`'s, never re-exported here (one value, one path: `flight-copies`) and never a second one (auth's own suites need it, and auth cannot import testing) |
| A reached job is crash-proven | `exercise-crash.ts`: only `diverged` is red (`X_JOB_CRASH_DIVERGED`) † |
| The tenant proof is taint only | `tenant-proof.ts`: B, A, B; B is A's role minus `tenancy:cross`. Leak = seeded canary or unhanded id (`tenant-canary.ts`); write = moved digest. Only `crossed` is red |
| Every statement the pass sent is planned | `plan-sweep.ts` + `plan-oracle.ts`: `X_QUERY_UNINDEXED` / `X_QUERY_SORT_UNSERVED` with the `indexes:` fix; no generic plan is `X_QUERY_PLAN_UNAVAILABLE`, never a pass † |
| A shape that grows with the rows is red | `scale-sweep-run.ts` + pure `judgeScale`: `X_QUERY_SCALES_WITH_ROWS` † |
| A sized-seed refusal is one finding, not N `unproven` | `scale-sweep-seed.ts`: table by table; only a primitive that read the lost table is `unproven`, `scaleSeedFindings` → `X_EXERCISE_SEED_FAILED` (`scale-sweep-run.test.ts`) |
| A lost table is read where a table is named | `sql-tables.ts` `statementTables`: `from`/`join`/`update`/`into`/`using` and their comma lists, never a column spelled like one; a view or history table over a lost table is lost too (`scale-sweep-seed.test.ts`). `x doctor`'s raw tenant SQL probe reads tables by the same function |
| One call has a statement ceiling | `exercise-statement-ceiling.ts`: `STATEMENTS_MAX` 100 per call, `statements: { max, why }` per entry; `X_STATEMENTS_OVER_BUDGET` (`exercise-statement-ceiling.test.ts`) |
| An erase is PROVED, not asserted | `subject-proof.ts`: a survivor outside `retain` is `X_SUBJECT_ERASE_INCOMPLETE`, never the value † |
| A captured failure replays as a test | `repro.ts`: `reproduce(bundle, { driver })`, `reproJob(runJobs, failure)` — what `x repro --write` emits † |
| A vendor's answers are a cassette | `cassette.ts`: replay = `mockFetch` routes, seal kept; record refused under `CI`, secrets scanned before disk; written by action's `stableStringify`, loaded dynamically (`serializeCassette`) † |
| One seed writer | `entitySeedWriter({ entities, client \| driver })` (`seed-writer.ts`) writes through each entity's own repository; `snapshot` is required; `entity` loads on the first write, so the barrel stays entity-free |
| Factory values are DECLARED | `seed-graph-values.ts` for `factoriesFor` and `seedGraph`: default, enum, kind, pattern, `$meta.schema` — never the name † |
| e2e without a driver | `e2eTest` becomes `test.skip`; the gate reports the step SKIPPED (or `X_VERIFY_SUITE_VANISHED` when `x.verify.json` requires it), never passed |
| The seam has an inverse | `resetE2eDriver()`: `useE2eDriver` writes MODULE scope, so a file that installs a browser undoes it |
| Built vs declared | `clock` `mail` `network` `runJobs` `statements` `subscribe` are built in-process; `page` `budget` `signIn` `deploy` are declared and wait for a driver (`X_TEST_FIXTURE_UNAVAILABLE`). |
| `page` HAS a driver; `budget`, `signIn`, `deploy` do not | `installE2eDriver({ page, baseUrl })` registers `page` only. Byte counts, a sign-in route and a new build id are facts no page port can answer; a no-op would read as proof |
| `network` is THIS process's fetch, and an e2e page is not in this process | `network.offline()` beside `page` is a no-op on the browser. Full rule: `docs/history/testing.md` |
| `subscribe` is a whole `sync` node, minus the listener | `live-node.ts`; no client store, offline queue or rebase log † |
| Strict is opt-in by destructuring | `statements` subscribes the N+1 detector for one test; its first verdict raised at disposal (a subscriber cannot throw into the statement). No `strict: true` or suite-wide switch |
| One threshold, one error | `N_PLUS_ONE_THRESHOLD` and `nPlusOne()` are `@ultimat3/entity`'s, never a copy |
| The unit of work is the test | `x dev`'s ledger tallies per `Ctx` and ignores a statement issued outside a request |
| Throws once per shape | the failing line is the loop's own statement (why `onStatement` may throw) |
| Measure vs judge | `all()` `count()` `shapes()` count `expectedQueryLoop` statements too; only the verdict honours the suppression |
| One seam for drivers | a driver registers over a declaration with `defineFixtures` — merges, last wins. Never a second registration mechanism |
| A driver arrives whole | `defineFixtures` holds every name `Fixtures` declares to its declared type, so a half-built `page` is a compile error at the registration |
| Registry hygiene | the fixture registry is process-global; a test that clears it snapshots with `fixtureSnapshot()` and hands it back in `afterAll` |
| Leaks are the file's, not the next file's | `installRegistryLeakGuard()` runs from the preload and fails the run naming the FILE that left cache tags declared or a cache tier registered after its last test (`X_TEST_REGISTRY_LEAK`). |
| Reported and restored are different sets | the guard also RESTORES, at the same file boundary, the registries whose module-scope declarations a neighbour's cleanup destroys |
| A catalog restore is a MERGE, never a replace | the other three registries are replaced with the snapshot. `registerCatalog` has no inverse, so all a file can cost its neighbour is a `resetCatalogs()` |
| Permissions are still REPLACED at a file boundary, and it is measured | a dynamic `loadApp()`'s `definePermissions()` is dropped there. Open. Full rule: `docs/history/testing.md` |
| Guarded state is boot state | the guard covers only registries that must be clean at file end — `declareTags` and `registerTier` are boot installs; "filled" and "cleared" are two questions. Full rule: `docs/history/testing.md` |
| An empty registry is a premise you state | a test whose subject is "nothing is declared" — `x db gen` with nothing to generate — calls `isolateEntityRegistry()` and restores in a `finally`. |
| That one helper is off the barrel | `@ultimat3/testing/registry-isolation`, its own entry point. It is the only module here that value-imports `@ultimat3/entity` |
| Teardown restores, never uninstalls | `describeApp`/`testApp` capture the seal and the determinism snapshot before booting and put those back |
| Teardown is a `finally` | an `app.close()` that rejects still reaches `db.drop()` and still restores the process state; the first failure is what the caller sees. |
| A boot that rejects is its own teardown | `acquireWorkerDatabase`, `seed` or `boot` throwing returns no `BootedHarness`, so no caller can ever reach `close()` |
| A found template is not a migrated one | `template-db.ts` tolerates "already exists" for the `CREATE DATABASE` alone. `config.migrate` runs unconditionally; drop + clone hold the same lock |
| Fixture teardown | a fixture that installs process-global state (the ambient job or mail driver) implements `Symbol.dispose` / `Symbol.asyncDispose` and restores what was there |
| Building one by hand | `testJobs()` outside a fixture body is not disposed for you — dispose it in `afterEach`, or the next file inherits your queue and your event bus |
| Factory strategy | `build` (memory), `create` (STORED row), `attributesFor` (an input: no key, no parent key), `buildList`/`createList`. An association uses the strategy that asked: `build()` never reaches a database. Never a fifth strategy |
| One write seam | `create()` writes through `persistRow` (`usePersister`, else `entityPersister()`); `X_TEST_FACTORY_NOT_PERSISTED` † |
| One row pipeline | `factory-pipeline.ts` is a generator both strategies drive: `build` answers each yield in memory, `create` awaits it. Never a second copy of the row order — the seeded draws depend on it |
| Associations | `belongsTo(parent, 'fk')`, `hasMany(child, 'fk')`; the tenant column follows the parent † |
| Factory seeds | derived from the table name unless given. `reset()` cascades into parents and children, cycle-guarded. `factorySeed` restarts EVERY sequence (`resetFactorySequences`) so a replay draws the same ids |
| Factory lint | `lintFactories(set)` / `assertFactoriesValid(set)` (`X_TEST_FACTORY_INVALID`): each factory and each trait alone, built (`$parse` + `$assert`, unknown keys) and created into its OWN fresh memory driver |
| Shared examples | `behavesLike` calls `describe`, so it goes at declaration scope; bun rejects a `describe` inside a test body |
| A port's contract is shared examples | one suite per port on `@ultimat3/testing/conformance`: `behavesLike(<port>Conformance, () => yours)`, each with a broken adapter that must fail † |
| An island needs a BUILDER, not an import | `buildIslands` is `@ultimat3/cli`'s; `testing → cli` fails `bun run boundaries` |
| `mountIsland` AWAITS `mount` | `IslandEntry['mount']` returns `unknown`, not `void`, and the call is awaited |
| Dispose STOPS the island, then restores the globals | when `mount` resolved to a function, `[Symbol.dispose]` calls it BEFORE `restore()` |
| The micro-DOM is the fixture's, once **for islands** | `island-dom.ts`. Full rule: `docs/history/testing.md` |
| The micro-DOM records and does not pretend | records `style`/`classList`; the box is 0 until written; `ResizeObserver` never fires itself † |
| The selector grammar is SMALL and REFUSES | `island-selector.ts`: anything else is `X_TEST_ISLAND_SELECTOR_UNSUPPORTED` † |
| A mount installs process globals | so `MountedIsland` is `Disposable` and a `mount` that THROWS restores before it rethrows. A fake `document` left installed reaches every later FILE in the run |
| `fire` answers whether a handler ran | a selector matching nothing and an island that attached no handler are the same silence otherwise — the second is a bug, the first a typo. |
| A states file is PURE DATA, and it is enforced | `defineIslandStates` declares the states an island can be photographed in — error, empty, over-quota, read-only |
| The rule is the RELATIVENESS, not the extension | `import { X } from './settings.island'` resolves to `./settings.island.tsx` under Bun, so any relative runtime import is refused |
| `import type` is not an import, and it is the one way to name the component | `verbatimModuleSyntax` erases a statement that BEGINS `import type` / `export type` |
| Unreadable is not pure | a computed specifier is `IslandStatesOpaqueImportError` |
| What the scan does NOT follow | a BARE specifier other than `solid-js`, an ABSOLUTE path (both holes), and a specifier inside a string LITERAL (a false refusal, the safe direction) |
| Props are JSON or they are refused | they ride `data-x-props` (`emitIslandProps`). Full rule: `docs/history/testing.md` |
| The clock is pinned in the vocabulary, zone included | `timeZone` defaults to `ISLAND_SHOT_TIME_ZONE` (`UTC`) and `now` to this package's own `DEFAULT_NOW`, and both ride onto every `IslandShotTarget`. |
| Loose in, strict out | `findIslandStates` resolves any spelling of one island; an unknown name lists EVERY valid one |
| The disk check is not in `defineIslandStates` | Full rule: `docs/history/testing.md` |
| The island EXTENSION is not restated here | `ISLAND_EXTENSION` is `@ultimat3/render`'s |
| A mount imports from its own temp DIRECTORY | `island-scratch.ts`, never a `data:` URL. Full rule: `docs/history/testing.md` |
| Globals install in layers | `island-globals.ts`: a key's real DESCRIPTOR is saved by the first live mount, restored by the last, in any dispose order |
| Which command shards | `bun test` is one process on one database — what a scaffolded app's `test` script runs |

## Properties and the soak never read ambient randomness

`property()` draws from its own `seededRandom(seed)`, never the preload's `Math.random`; `soak()`
reads `bun:jsc`'s `heapStats()` after `Bun.gc(true)` twice. The eight framework properties live in
`src/property-*.test.ts`, not beside their sources: a tier ≤ 4 test cannot import this package.

## The frozen instant and the seed are screened

Through one `instantMs` and core's `finiteOption`/`finiteCount` (`determinism-bounds.test.ts`). Full rule: `docs/history/testing.md`.

Commands: `bun test ./packages/testing/` (from the repo root — the `./` keeps `examples/dummy` out), `bunx tsc --noEmit -p tsconfig.json`.

Entry points: `.` (the API), `./preload` (side effects for bunfig), `./registry-isolation`
(`isolateEntityRegistry()`, kept off `.` because it loads `@ultimat3/entity`) and `./conformance`
(every port suite; static imports of the packages they hold to, so never re-exported from `.`).

The island fixture's cost and its whole-chain proof: `docs/history/testing.md`.

## The browser-backed e2e driver (moved here from `@ultimat3/cli` in 22.0.0)

Raw CDP; `cli` imports it over `cli -> testing`. Launcher + connection: `@ultimat3/scraping/cdp`
(31.0.0), never re-exported. One job per
file (`e2e-*.ts`, `cdp-*.ts`); the table of which file does what is
[`docs/history/testing-e2e-driver.md`](../../docs/history/testing-e2e-driver.md). The ONE call an
app's test preload makes is `installE2eDriver({ page, baseUrl })` (`e2e-driver.ts`).

**Absent by default** until `installE2eDriver`: [`docs/history/testing.md`](../../docs/history/testing.md#the-browser-backed-e2e-driver-moved-here-from-ultimat3cli-in-2200).

How the raw-CDP driver behaves — the pipe, the load event, deadlines, the lossy `evaluate`, the
refusing `update()` — is [`docs/history/testing.md`](../../docs/history/testing.md#the-e2e-driver-in-brief-moved-2026-10-01).

The reasoning behind every rule above, verbatim, is [`docs/history/testing.md`](../../docs/history/testing.md).

