# @ultimat3/testing — boundary

Tier 5. May import tiers 0–4. Imported by every package's tests and by generated apps.

Deps (16): `core` `schema`; `cache` `db` `i18n` `time`; `entity` `http` `policy`; `action`
`jobs` `query` `realtime`; `mail` `pwa` `render`. Static in `.`: `cache`
(`registry-leak-guard.ts:7`), `i18n`, `jobs`, `policy` (`registry-snapshot.ts:29-38`), `db`
(`reusable-database.ts:20`), `realtime/server` (`fixture-subscribe.ts:13`). Dynamic-only:
`action`, `http`, `mail`, `pwa`, `query`, `render`, `schema` (`exercise-input.ts:16`), `time` — no `mail` destructure, no mail
package; a `packages/core` import never loads `@ultimat3/entity`. `entity` is reached by `await import` only
(seed writer, tenant witness, `nPlusOne()`, repro, subject proof, the row observer); its one static
import is `registry-isolation.ts`, own entry point, off the barrel. Full rule: `docs/history/testing.md`.

| Rule | Detail |
|---|---|
| No mocks of the DB | clone a template database; `template-db.ts` is the only DB path |
| No wall clock | `withFrozenClock` / `advanceClock`; `Date.now()` is frozen by the preload |
| Frozen ≠ different | `globalThis.Date` becomes a subclass; `FrozenDate[Symbol.hasInstance]` brands on the `[[DateValue]]` slot (`Date.prototype.getTime.call(value)` throws or not) |
| No unmocked egress | `sealed-network.ts` seals `fetch`; `sealed-sockets.ts` `WebSocket`, `Bun.connect`, `node:*`, UDP (not loopback); `sealed-dns*.ts` every resolver, named imports too (wiki `Testing.md`); a miss is `X_TEST_NETWORK_SEALED` |
| One `mockFetch`, and it grows | a verb in the match, ordered answers, a pinned dial's name (`mock-route.ts`) and `requestLog` (`request-log.ts`). A stream bound for a real server logs `null` (teeing drains it). `original(input, init)` goes as handed: `tls`, `unix`, `proxy` are in no `Request`. `cassette()`: below |
| Self is not egress | a port core's `markListening()` announced passes through — a socket test never unseals |
| Offline is a state, not a mock | `network.offline()` / `.drop()` fail every dial, loopback too, as `X_TEST_NETWORK_OFFLINE` before any mock: the app's offline path runs |
| One way offline | the `network` fixture. `setNetworkState` is the gate's only writer and is not exported — setting it from a test body skips the fixture's disposal and leaves every later file offline |
| The seal key is a test process's, and nobody's export | `test-seal-key.ts`: installed by the preload only when `NODE_ENV === 'test'` and neither `ULTIMATE_SECRETS_KEY` nor `.secrets.key` exists. Full rule: `docs/history/testing.md` |
| `toEqualRow` never prints a server-only value | `matcher-row.ts` compares every OWN property (`toEqual` cannot see a `.sealed()` column — empty diff). Full rule: `docs/history/testing.md` |
| No retries | a flake is fixed or deleted the day it flakes; there is no `retry: 3` |
| A mutator's `local()` runs against `memoryLocalTx()` | `local-tx.ts`: keyed rows with the record store's rules (update invents nothing, `undefined` leaves a column, rows frozen). Never a hand-rolled table per test |
| A page test RENDERS, with no cast | `render-view.ts`: `renderRoute(module, { url, actor })` resolves `load` once and hands `meta` and the page that one object, as every render mode does; `renderView(Component, props)` is one component. Full rule: `docs/history/testing.md` |
| `toBeUltimateError` reads THREE fields | an `X_` code plus a `cause` plus a `fix`, all through core's `stringField`. `typeof value.code === 'string'` alone passed a Node `ENOENT` |
| One matcher WAITS, and it is `toBeVisible` | `await expect(locator).toBeVisible()` retries `isVisible()` to a budget — 5000ms every 100ms, Playwright's own default, narrowable per call. |
| The budget is counted in LOOKS, at a FIXED interval | `attemptsFor(budget)` is `1 + floor(timeout / interval)`; never a clock deadline, never a curve. Full rule: `docs/history/testing.md` |
| A matcher that may throw a coded error MUST NOT be `async` | bun REPLACES an `async` matcher's thrown error with `returned a promise that rejected`, so code, cause and fix are gone. Full rule: `docs/history/testing.md` |
| Wrong receiver throws, wrong value returns | a wrong-shaped receiver is a coded throw, never `pass: false` |
| A matcher MESSAGE is a thunk, and never `JSON.stringify` | `result(pass, () => …)`. Full rule: `docs/history/testing.md` |
| Every message thunk needs a test that PROVOKES it | a thunk is a function, so an unread message is an UNCOVERED function and `bun run scripts/coverage-gate.ts --package testing` is what says so |
| Test names | the filename picks the step; a typed helper prefixes its own name. `testName(type, name)` is for an outer `describe` only — never on the inner `test` too, the prefix would print twice |
| One body shape, five registrars | `test` (= `fixtureTest`), `unitTest`, `contractTest`, `liveTest`, `jobTest` all take `FixtureBody` + `{ timeoutMs }`: `unitTest('…', async ({ runJobs }) => …)`. Never `describe(testName('unit', …))` + `test` to get a fixture |
| `runJobs` says who and what | `{ actor }` is the WORKER's identity (the org stays the job's declared tenant), `{ tenantId }` the enqueuer's row; `executions[n].result` is the body's return. A fresh event bus per fixture. Bodies run on the preload's frozen clock (`ctx.clock`), so a `backfill()` throttle moves `Date.now()` instead of sleeping |
| A `runJobs` pass is a real worker's `tick()` | `fixture-jobs.ts` builds an unstarted `jobWorker` per pass, so admission runs: `concurrency` waits and `whenBusy: 'fail'` refuses (`X_JOB_KEY_BUSY`) exactly as in a fleet. Full rule: `docs/history/testing.md` |
| Per-test state is `per-test-reset.ts` | the app preload's `beforeEach` resets the jobs event bus — only when `@ultimat3/jobs` is already loaded, so the reset never loads it |
| A `mock.module` ends with its file | `module-mock-boundary.ts` wraps it (and `vi.mock`/`jest.mock`): the real namespace is snapshotted on a file's first mock, so its top-level code RUNS, and mocked back at the boundary. A preload's mock is left. A real one that throws on load: the next file fails `X_TEST_MODULE_MOCK_UNRESTORABLE` |
| **The frozen clock is reset at every file boundary** | `preload.ts`, `clock-file-boundary.test.ts`: `advanceClock` / `setFrozenClock` move one process-wide instant, and a file that left it moved handed the next file on its worker a different `Date.now()` |
| An island test is `describeIslandState` | one block per declared state: mounted in `beforeAll` (60 s), disposed in `afterAll`, one build per file. `mountIslandState` + `using` for one test's own mount; an undeclared id is `X_TEST_ISLAND_STATE_UNKNOWN` |
| An authenticator is tested with `authRequest()` | the hook's own two arguments, real — never `as unknown as Parameters<…>` |
| `LOG_LEVEL` above `info` filters the TERMINAL | `quiet-logs.ts` pins the logger at `info` while core loads, so a collecting `setLogSink` still sees `warn` under `LOG_LEVEL=error`. It stays the preload's FIRST import |
| Injection | `SqlRunner` and `connect` are parameters, so unit tests need no server |
| Fixtures | the preload registers the framework bag — an app registers only what it alone knows (`seed`, `actorFor`) |
| Every `e2eTest` is audited | `e2e-a11y.ts` (rules), `e2e-a11y-run.ts` (per-test run, `allow`, dedupe), `ax-node.ts` (the one AX reader); full tree only in `cdp-e2e-page.ts`. No switch; `allow` needs a `because`. Raw tabs: `e2e-a11y-tabs.ts` ([history](../../docs/history/testing.md#a11y-on-raw-tabs)) |
| The exercise pass runs what is registered | `exercise.ts` (`runExercisePass`): every action, query and job once, its own tenant pair off one `seedGraph`, an actor `exercise-actor.ts` picks, 39's `runExercise` as the verdict. Rows COMMITTED. Overrides only via `defineExercise` (blank `off` refused). A job runs ALONE (`exercise-job-run.ts`): a fresh queue, one `tick()`, what it queued left on the caller's queue unrun — never a `drain()` |
| An override `input` is awaited, as the call's actor | `exercise-override-input.ts`: run inside the call's own request, so `useContext().actor` is the seated actor; the one way to a signed input. `async` ones are left out of `x drill`'s load |
| A passkey test signs for real | `softAuthenticator` is `@ultimat3/auth/soft-authenticator`'s, never re-exported here (one value, one path: `flight-copies`) and never a second one (auth's own suites need it, and auth cannot import testing) |
| A reached job is crash-proven | `exercise-crash.ts`: `crashProof` with the control's input and actor, after the tenant proof; only `diverged` is red (`X_JOB_CRASH_DIVERGED`), its place `crashEffectPlace` (`inside` a step via jobs' `currentStep()`, or `after` one). Its world is `alone`: only the job's own row is claimed, a child is an `enqueue:` effect, never run. Committed: job bodies escape transactions |
| The tenant proof is taint only | `tenant-proof.ts`: B, A, B; B is A's role minus `tenancy:cross`. Leak = seeded canary or unhanded id (`tenant-canary.ts`); write = moved digest. Only `crossed` is red |
| Every statement the pass sent is planned | `plan-sweep.ts` (`sweepPlans`): first relation an app table, `PREPARE` in a READ-ONLY transaction with seq/bitmap scans off (sorts too, re-planned, for a limited read's sort), judged by `plan-oracle.ts` (keys: `plan-sort-key.ts`, conditions: `plan-conditions.ts`); red = `X_QUERY_UNINDEXED` / `X_QUERY_SORT_UNSERVED` with the `indexes:` entry (`plan-sweep-fix.ts`). `scan:` or `expectedSeqScan` is exempt, listed; credited: a partial unique whose predicate the statement states, equality-then-range index under a limit, every `or` arm a declared index leads, a whole read a keyed join side probes by a declared index (`plan-probes.ts`); no generic plan is `X_QUERY_PLAN_UNAVAILABLE`, never a pass |
| A shape that grows with the rows is red | `scale-sweep-run.ts`: two more tenants at `SCALE_SIZES` (2, 8 rows a table), every reached primitive once in each; `judgeScale` (pure) reds `X_QUERY_SCALES_WITH_ROWS`. Under `expectedQueryLoop` it is listed with its reason |
| An erase is PROVED, not asserted | `subject-proof.ts` (`subjectProof`, run by cli's `exercise-subject.ts`): canaries in every table, one person erased, every stored row searched; a survivor outside `retain` is `X_SUBJECT_ERASE_INCOMPLETE`, naming table and column, never the value |
| A captured failure replays as a test | `repro.ts`: `reproduce(bundle, { driver })` seeds the rows it read, freezes the clock at its instant, invokes as its actor; masked fields are stood in (`repro-stand-in.ts`). An unregistered name ANSWERS as the failure. `reproJob(runJobs, failure)` for a dead job. What `x repro --write` emits |
| A vendor's answers are a cassette | `cassette.ts`: replay = one `mockFetch` route per recorded URL, seal kept (`X_CASSETTE_MISSING`, `X_CASSETTE_UNUSED`). Record = `ULTIMATE_CASSETTE=record` + `record.hosts`, refused under `CI` (`X_CASSETTE_RECORD_REFUSED`), headers allow-listed, credential keys masked, bytes scanned before disk (`X_CASSETTE_SECRET`). The request side is never written |
| One seed writer | `entitySeedWriter({ entities, client \| driver })` (`seed-writer.ts`) writes through each entity's own repository; `snapshot` is required; `entity` loads on the first write, so the barrel stays entity-free |
| Factory values are DECLARED | `factoriesFor` and `seedGraph` share `seed-graph-values.ts`: default, enum, kind, a `matches()` pattern (schema's `patternSamples`; CHECK read by `seed-graph-patterns.ts`), `$meta.schema` (sampler `require`d on first use), through `$parse`, never the name. `seed-graph*.ts` type-import `entity` only |
| e2e without a driver | `e2eTest` becomes `test.skip`; the gate reports the step SKIPPED (or `X_VERIFY_SUITE_VANISHED` when `x.verify.json` requires it), never passed |
| The seam has an inverse | `resetE2eDriver()`: `useE2eDriver` writes MODULE scope, so a file that installs a browser undoes it |
| Built vs declared | `clock` `mail` `network` `runJobs` `statements` `subscribe` are built in-process; `page` `budget` `signIn` `deploy` are declared and wait for a driver (`X_TEST_FIXTURE_UNAVAILABLE`). |
| `page` HAS a driver; `budget`, `signIn`, `deploy` do not | `installE2eDriver({ page, baseUrl })` registers `page` only. Byte counts, a sign-in route and a new build id are facts no page port can answer; a no-op would read as proof |
| `network` is THIS process's fetch, and an e2e page is not in this process | `network.offline()` beside `page` is a no-op on the browser. Full rule: `docs/history/testing.md` |
| `subscribe` is a whole `sync` node, minus the listener | `live-node.ts`; no client store, offline queue or rebase log (`feed.local()` is `undefined`); `settled()` yields by `setImmediate`; a lone subscriber re-snapshots. Full rule: `docs/history/testing.md` |
| Strict is opt-in by destructuring | `statements` installs the N+1 detector in throw mode for one test. No `strict: true`, no suite-wide switch |
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
| Factory strategy | an association is built with the strategy that asked for it: `build()` never reaches a database, `create()` writes the parent first. Never a third strategy |
| One write seam | `usePersister` is the only place `create()` writes. A factory that took a repo argument would put the seam at every call site |
| Factory seeds | derived from the table name unless given, so two entities never draw the same uuid stream. `reset()` cascades into associated parents — a half-reset row is worse than none |
| Shared examples | `behavesLike` calls `describe`, so it goes at declaration scope; bun rejects a `describe` inside a test body |
| A port's contract is shared examples | `jobDriverConformance`, `budgetStoreConformance` — `behavesLike(…, () => yours)` |
| An island needs a BUILDER, not an import | `buildIslands` is `@ultimat3/cli`'s; `testing → cli` fails `bun run boundaries` |
| `mountIsland` AWAITS `mount` | `IslandEntry['mount']` returns `unknown`, not `void`, and the call is awaited |
| Dispose STOPS the island, then restores the globals | when `mount` resolved to a function, `[Symbol.dispose]` calls it BEFORE `restore()` |
| The micro-DOM is the fixture's, once **for islands** | `island-dom.ts`. Full rule: `docs/history/testing.md` |
| The micro-DOM records and does not pretend | `style`/`classList` record, a `document` listener is the documentElement's, `querySelector` skips `this`, the box is 0 until written, `ResizeObserver` never fires itself, attaching a node moves it. Full rule: `docs/history/testing.md` |
| The selector grammar is SMALL and REFUSES | `island-selector.ts`: compounds of tag, `#id`, `.class`, `[attr]`, `[attr="value"]`, joined by space or `>`. Anything else is `X_TEST_ISLAND_SELECTOR_UNSUPPORTED` with the offset, never an empty answer |
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

## The frozen instant and the seed are screened

Through one `instantMs` and core's `finiteOption`/`finiteCount` (`determinism-bounds.test.ts`). Full rule: `docs/history/testing.md`.

Commands: `bun test`, `bunx tsc --noEmit -p tsconfig.json`.

Entry points: `.` (the API), `./preload` (side effects for bunfig) and `./registry-isolation`
(`isolateEntityRegistry()`, kept off `.` because it loads `@ultimat3/entity`).

The island fixture's cost and its whole-chain proof: `docs/history/testing.md`.

## The browser-backed e2e driver (moved here from `@ultimat3/cli` in 22.0.0)

Raw CDP: `@ultimat3/core` and Bun, nothing else; `cli` imports it over `cli -> testing`. Full rule: `docs/history/testing.md`.

| File | Job |
|---|---|
| `e2e-driver.ts` | `installE2eDriver({ page, baseUrl })` — the ONE call an app's test preload makes. Registers `page` over its declaration and installs the `e2eTest` seam; returns the undo |
| `e2e-page.ts` | `PageLike` over four members of `ScrapePage`, declared structurally so a test stands one up in six lines |
| `e2e-locator.ts` | `LocatorLike` — a handle that resolves nothing until asked, one round trip per question |
| `e2e-selection.ts` | what a locator SELECTS, as data, and the one in-page expression that resolves it |
| `e2e-evaluate.ts` | the closure→string crossing, which is the only lossy edge in the adapter |
| `e2e-errors.ts` | one constructor per refusal |
| `e2e-dom-fixture.ts` | a document small enough to hold in a test and real enough to RUN the expressions above |
| `cdp-browser.ts` | the two doors: `openE2eBrowserIfAvailable()` (undefined when there is no browser) and `openE2eBrowser()` (refuses by name), and the close that undoes both halves |
| `cdp-launch.ts` | which Chrome, its flags, the launch deadline (`LAUNCH_TIMEOUT_MS`, 60 s — a cold start is not a call) and the ONE relaunch (`LAUNCH_ATTEMPTS`) |
| `cdp-launch-attempt.ts` | one start in its own group; on no answer a full reap (group, then profile + singleton dir: `cdp-launch-profile.ts`). ONE awaited `close()` |
| `cdp-connection.ts` | CDP over a transport — the launched Chrome's pipe (`cdp-pipe.ts`), a remote one's `WebSocket` (`cdpConnect`): reply correlation by `id`, event waiters, the per-call deadline; why one went unanswered is `cdp-wire-watch.ts` |
| `cdp-e2e-session.ts` | the BROWSER half, `E2eSession`: every target PAUSED until its Network domain is on |
| `cdp-e2e-page.ts` | one TAB, `E2eTab`: `E2eBrowserPage`'s six methods (`accessibilityTree` required) plus `reload`, `waitFor`, `indexedDbNames`, `close`. `offline()` forwards to the session — the switch is browser-wide |
| `e2e-app.ts` | `startE2eApp({ root, mode, seed })`: a THROWAWAY `ULTIMATE_STATE_DIR`, `/readyz`-gated; `stop()` removes it. Full rule: `docs/history/testing.md` |
| `failure-context.ts` | a FAILED test's message ends with the e2e app's last 40 log lines (≤ 4 kB): `e2e-run.ts` installs `app.log()`, `fixtureTest` and `e2eTest` append it. Never on a pass |
| `e2e-preload.ts` + `e2e-browser-handle.ts` | the `e2e` step's preload (`@ultimat3/testing/e2e-preload`): with `ULTIMATE_E2E_ROOT` set it spawns the app, opens ONE browser, installs its first tab, and publishes `e2eBrowser()`, `e2eApp()`, `e2eBaseUrl()` |
| `packages/cli/src/verify-e2e.ts` | `withE2eApp` (cli's): in an app on a machine with Chrome, the `e2e` step runs the suite with that preload; otherwise exactly as before |
| `cdp-errors.ts` | one constructor per way the browser half refuses |

**Absent by default** until `installE2eDriver`: [`docs/history/testing.md`](../../docs/history/testing.md#the-browser-backed-e2e-driver-moved-here-from-ultimat3cli-in-2200).

How the raw-CDP driver behaves — the pipe, the load event, deadlines, the lossy `evaluate`, the
refusing `update()` — is [`docs/history/testing.md`](../../docs/history/testing.md#the-e2e-driver-in-brief-moved-2026-10-01).

The reasoning behind every rule above, verbatim, is [`docs/history/testing.md`](../../docs/history/testing.md).

