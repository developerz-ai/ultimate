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
| Frozen ≠ different | `globalThis.Date` becomes a subclass, so `FrozenDate[Symbol.hasInstance]` brands on the `[[DateValue]]` slot — `Date.prototype.getTime.call(value)` throws or it doesn't. |
| Slot, not prototype | the brand is cross-realm on purpose: `instanceof RealDate` misses a `node:vm` or worker Date, and `Object.prototype.toString` is spoofable by `Symbol.toStringTag: 'Date'`. Only the slot is both |
| No unmocked egress | `sealed-network.ts` patches fetch; a miss is `X_TEST_NETWORK_SEALED` |
| Self is not egress | a port core's `markListening()` announced passes through — a socket test never unseals |
| Offline is a state, not a mock | `network.offline()` / `.drop()` fail every request as `X_TEST_NETWORK_OFFLINE`, ahead of the mocks — the app's own offline path runs |
| One way offline | the `network` fixture. `setNetworkState` is the gate's only writer and is not exported — setting it from a test body skips the fixture's disposal and leaves every later file offline |
| No retries | a flake is fixed or deleted the day it flakes; there is no `retry: 3` |
| `toBeUltimateError` reads THREE fields | an `X_` code plus a `cause` plus a `fix`, all through core's `stringField`. `typeof value.code === 'string'` alone passed a Node `ENOENT` |
| One matcher WAITS, and it is `toBeVisible` | `await expect(locator).toBeVisible()` retries `isVisible()` to a budget — 5000ms every 100ms, Playwright's own default, narrowable per call. |
| The budget is counted in LOOKS, not milliseconds | this package freezes `Date.now()`, so a deadline computed from the clock never expires and the loop spins forever. `attemptsFor(budget)` is `1 + floor(timeout / interval)` |
| A FIXED interval, and never a curve | doubling the gap makes the last look land long after the state changed, and the caller's deadline is the contract. |
| A matcher that may throw a coded error MUST NOT be `async` | bun REPLACES an `async` matcher's thrown error with `returned a promise that rejected`, so code, cause and fix are gone. A synchronous prologue validates the receiver, then a promise is returned; `matcher-receiver.test.ts` pins all four |
| Wrong receiver throws, wrong value returns | a matcher handed a page where a locator belongs is not FALSE, it is unanswerable — `pass: false` would read as "the element was hidden". A wrong-shaped receiver is a coded throw |
| A matcher MESSAGE is a thunk, and never `JSON.stringify` | `result(pass, () => …)` — `expect.extend` reads `message()` only on the wrong verdict, and the string used to be built EAGERLY. |
| Every message thunk needs a test that PROVOKES it | a thunk is a function, so an unread message is an UNCOVERED function and `bun run scripts/coverage-gate.ts --package testing` is what says so |
| Test names | the filename picks the step; `testName(type, name)` on the outer `describe` puts that type on every failure line under it. Never on the inner `test` too — the prefix would print twice |
| `test` here is `fixtureTest`, and it takes no timeout | `(name, body)`, nothing else (`fixtures.ts:248`, exported as `test` by `index.ts:107`) |
| Injection | `SqlRunner` and `connect` are parameters, so unit tests need no server |
| Fixtures | the preload registers the whole framework bag — an app registers only what the framework cannot know (`seed`, `actorFor`) |
| e2e without a driver | `e2eTest` becomes `test.skip`, and the gate reports the step GREEN over it — `bun test` exits 0 on a skip and the exit code is the only channel between the step and the child that registers the driver. |
| The seam has an inverse | `resetE2eDriver()`. `useE2eDriver` writes MODULE scope and `bun test` is one process, so a file that installs a browser must undo it |
| Built vs declared | `clock` `mail` `network` `runJobs` `statements` `subscribe` are built in-process; `page` `budget` `signIn` `deploy` are declared and wait for a driver (`X_TEST_FIXTURE_UNAVAILABLE`). |
| `page` HAS a driver; `budget`, `signIn`, `deploy` do not | `installE2eDriver({ page, baseUrl })` registers `page` only. Byte counts, a sign-in route and a new build id are facts no page port can answer; a no-op would read as proof |
| `network` is THIS process's fetch, and an e2e page is not in this process | `network.offline()` beside `page` is a no-op on the browser. `E2eFixtures.offline()` is the browser-side spelling and forwards to `E2eBrowserPage.offline()`; a page port with none refuses by name |
| `subscribe` is a whole `sync` node | `live-node.ts` assembles what `x dev --role sync` assembles minus the listener — real `LiveQueryRegistry`, real `liveQueryDefinition` bridge, real per-subscriber gate, real cursor |
| What `subscribe` does NOT hold | a client store, an offline queue or a rebase log — so `feed.local()` answers `undefined` rather than the server row. |
| Draining is a macrotask yield | the node dispatches `message` into a floating async task, so `settled()` yields with `setImmediate` until the frame count stops moving. |
| A lone subscriber cannot resume | the retained window is the registry's ENTRY and the entry is dropped when its last subscriber goes, so a reconnect with nobody else holding it re-snapshots — correctly. |
| Strict is opt-in by destructuring | `statements` installs the N+1 detector in throw mode for one test. A fixture nobody names is a fixture nobody built, so there is no `strict: true` and no suite-wide switch |
| One threshold, one error | `N_PLUS_ONE_THRESHOLD` and `nPlusOne()` are `@ultimat3/entity`'s. A number or a message written here would make a loop that fails a test a different loop from the one `x dev` warns about |
| The unit of work is the test | `x dev`'s ledger tallies per `Ctx` and ignores a statement issued outside a request |
| Throws once per shape | the failing line is the loop's own statement (the seam lets `onStatement` throw for this reason alone). |
| Measure vs judge | `all()` `count()` `shapes()` count `expectedQueryLoop` statements too; only the verdict honours the suppression, so "this page issues two statements" never depends on who declared what |
| One seam for drivers | a driver registers over a declaration with `defineFixtures` — merges, last wins. Never a second registration mechanism |
| A driver arrives whole | `defineFixtures` holds every name `Fixtures` declares to its declared type, so a half-built `page` is a compile error at the registration, not a missing method three awaits later |
| Registry hygiene | the fixture registry is process-global; a test that clears it snapshots with `fixtureSnapshot()` and hands it back in `afterAll` |
| Leaks are the file's, not the next file's | `installRegistryLeakGuard()` runs from the preload and fails the run naming the FILE that left cache tags declared or a cache tier registered after its last test (`X_TEST_REGISTRY_LEAK`). |
| The baseline is not a hook | measured on Bun 1.3.14 the order is onLoad → module eval → file `beforeAll` → describe `beforeAll` → preload `beforeEach`, so a preload hook cannot sample before the file's own `beforeAll` |
| Reported and restored are different sets | the guard also RESTORES, at the same file boundary, the registries whose module-scope declarations a neighbour's cleanup destroys |
| A catalog restore is a MERGE, never a replace, `As of 2026-08-23` | the other three registries are replaced with the snapshot; the catalogs are not. `registerCatalog` has no inverse, so the only thing a file can cost its neighbour is a `resetCatalogs()` |
| Permissions are still REPLACED at a file boundary, and it is measured | an app's `definePermissions()` reached only by a dynamic `loadApp()` is dropped at that file's boundary exactly as catalogs were; the union rule would leak `permissions.test.ts`'s declarations into every later file. Open, its own piece of work (history) |
| Guarded state is boot state | only the two registries whose honest invariant is "clean when the file ends" — `declareTags` and `registerTier` are boot installs. |
| Filled and CLEARED are different questions | and the row above answers only the first. "Idiomatic to leave filled" is about the leak REPORT |
| An empty registry is a premise you state | a test whose subject is "nothing is declared" — `x db gen` with nothing to generate — calls `isolateEntityRegistry()` and restores in a `finally`. |
| That one helper is off the barrel | `@ultimat3/testing/registry-isolation`, its own entry point. It is the only module here that value-imports `@ultimat3/entity` |
| Teardown restores, never uninstalls | `describeApp`/`testApp` capture the seal and the determinism snapshot before booting and put those back |
| Teardown is a `finally` | an `app.close()` that rejects still reaches `db.drop()` and still restores the process state; the first failure is what the caller sees. |
| A boot that rejects is its own teardown | `acquireWorkerDatabase`, `seed` or `boot` throwing returns no `BootedHarness`, so no caller can ever reach `close()` |
| A found template is not a migrated one | `template-db.ts` tolerates "already exists" for the `CREATE DATABASE` alone. `config.migrate` runs unconditionally and un-swallowed |
| Fixture teardown | a fixture that installs process-global state (the ambient job or mail driver) implements `Symbol.dispose` / `Symbol.asyncDispose` and restores what was there |
| Building one by hand | `createRunJobs()` outside `fixtureTest` is not disposed for you — reset the driver in `afterEach`, or the next file in the process inherits your queue |
| Factory strategy | an association is built with the strategy that asked for it: `build()` never reaches a database, `create()` writes the parent first. Never a third strategy |
| One write seam | `usePersister` is the only place `create()` writes. A factory that took a repo argument would put the seam at every call site |
| Factory seeds | derived from the table name unless given, so two entities never draw the same uuid stream. `reset()` cascades into associated parents — a half-reset row is worse than none |
| Shared examples | `behavesLike` calls `describe`, so it goes at declaration scope; bun rejects a `describe` inside a test body |
| An island needs a BUILDER, not an import | `buildIslands` is `@ultimat3/cli`'s and both packages are tier 5; the one declared edge is `cli → testing`, so the reverse is a `bun run boundaries` failure. |
| `mountIsland` AWAITS `mount` | `IslandEntry['mount']` returns `unknown`, not `void`, and the call is awaited |
| Dispose STOPS the island, then restores the globals | `mountIsland` keeps what `mount` resolved to and, when it is a function, calls it in `[Symbol.dispose]` BEFORE `restore()` |
| The micro-DOM is the fixture's, once **for islands** | `island-dom.ts`. `packages/ui/src/fake-dom.ts` is a second one for keyboard code, and `ui -> testing` is upward, so it is not a copy to collapse. `bun test` has no DOM and no DOM library may be added |
| `style` and `classList` RECORD | `FakeStyle` is one declaration map behind all four spellings compiled Solid uses (static attribute, `setProperty`, `cssText`, `removeAttribute`), so a test can assert the component set `--form-gap` |
| `classList` is the class attribute | not a list of its own, so `classList.toggle` — what the compiler emits INLINE for `classList={{ … }}`, with no runtime helper in front of it — and `className` can never answer one element two ways. |
| A `document` listener is the documentElement's | no bubbling: `document.addEventListener` registers on `documentElement`, and `fire(mounted.documentElement, 'keydown', …)` drives it. One handler per type, last wins |
| `querySelector` skips `this` | descendants only, as the DOM's does. Matching the element it is called on made a host `<div>` answer `find('div')` with the container the test built rather than the markup the island rendered |
| The selector grammar is SMALL and REFUSES | `island-selector.ts`: compounds of tag, `#id`, `.class`, `[attr]`, `[attr="value"]`, joined by space or `>`. Anything else is `X_TEST_ISLAND_SELECTOR_UNSUPPORTED` with the offset, never an empty answer |
| The box is 0 until a test writes it | `clientHeight`, `scrollTop`, `scrollHeight` and the rest are plain writable numbers, default 0, and `getBoundingClientRect()` derives from the offset box. |
| `ResizeObserver` records and never fires on its own | `island-observers.ts`, one registry PER DOCUMENT. |
| A mount installs process globals | so `MountedIsland` is `Disposable` and a `mount` that THROWS restores before it rethrows. A fake `document` left installed reaches every later FILE in the run, and fails somewhere with no thread back |
| `fire` answers whether a handler ran | a selector matching nothing and an island that attached no handler are the same silence otherwise — the second is a bug, the first a typo. |
| A states file is PURE DATA, and it is enforced | `defineIslandStates` declares the states an island can be photographed in — error, empty, over-quota, read-only |
| The rule is the RELATIVENESS, not the extension, `As of 2026-08-23` | the scan refused `solid-js` and a specifier ENDING in `.tsx`/`.jsx`, and `import { X } from './settings.island'` resolves to `./settings.island.tsx` under Bun |
| `import type` is not an import, and it is the one way to name the component | `verbatimModuleSyntax` erases a statement that BEGINS `import type` / `export type` |
| Unreadable is not pure | a computed specifier — ``import(`./${name}.island`)``, `require(SPEC)` — is refused as `IslandStatesOpaqueImportError` rather than passed. |
| What the scan does NOT follow, stated rather than silent | a BARE specifier other than `solid-js`, an ABSOLUTE path specifier, and a specifier inside a string LITERAL (read as an import). The first two are holes; the third is a false refusal, the safe direction |
| Props are JSON or they are refused | they ride `data-x-props`, which `@ultimat3/render`'s `emitIslandProps` `JSON.stringify`s, so anything else is a prop the component never receives. |
| The clock is pinned in the vocabulary, zone included | `timeZone` defaults to `ISLAND_SHOT_TIME_ZONE` (`UTC`) and `now` to this package's own `DEFAULT_NOW`, and both ride onto every `IslandShotTarget`. |
| Loose in, strict out | `findIslandStates` resolves `Settings`, `settings`, `settings.island.tsx` and the full path to one manifest, and refuses a name nothing answers to by listing EVERY valid one |
| The disk check is not in `defineIslandStates` | a declaration evaluates wherever it is imported from, so a rule that reads the filesystem at import time fails on the cwd rather than on the path. |
| The island EXTENSION is not restated here | `.island.tsx` is `@ultimat3/render`'s `ISLAND_EXTENSION` and `render` is not a dependency of this package. |
| The chunk is imported from a temp FILE | named by its SHA-256, so an edit is a new module and nothing is left in the app. Never a `data:` URL: `bun test --coverage` panics importing one past ~4 kB (Bun 1.4.0); `fixture-island.test.ts` pins it |
| The scratch directory is lazy and removed, `As of 2026-08-22` | `mkdtempSync` ran at MODULE scope and nothing removed it, so every process importing `@ultimat3/testing` at all — this module is on the `.` barrel, so `expect` alone did it |
| Attaching a node MOVES it | `appendChild`, `insertBefore` and `replaceChild` detach the node from its old parent first, and `removeChild` clears `parentNode` |
| Globals install all-or-nothing | `installGlobals` saves DESCRIPTORS, not values — a saved value cannot tell "no such global" from "a global holding `undefined`", and the teardown deleted both |
| Which command shards | `bun test` is one process on one database, and that is still what a scaffolded app's `test` script runs. |


## The frozen instant and the seed are screened

`installDeterminism({ now })`, `setFrozenClock`, `frozenClock` and `advanceClock` go through one
`instantMs`: an unreadable instant would make `Date.now()` answer `NaN` for every later file. The
seed is screened too — `seed >>> 0` maps `NaN`, `0.5` and `2 ** 32` onto seed 0 silently.
`finiteOption`/`finiteCount` from `@ultimat3/core` are the one form; `determinism-bounds.test.ts`
holds both sides.

Commands: `bun test`, `bunx tsc --noEmit -p tsconfig.json`.

Entry points: `.` (the API), `./preload` (side effects for bunfig) and `./registry-isolation`
(`isolateEntityRegistry()`, kept off `.` because it loads `@ultimat3/entity`).

`fixture-island.ts`, `island-dom.ts`, `island-selector.ts` and `island-observers.ts` are on `.` and
import `@ultimat3/core` and nothing else, so they cost a tier-0 test nothing. The whole-chain proof — real Babel, real Solid, a real island —
is `examples/dummy/apps/web/app/settings/settings.island.test.ts`; `fixture-island.test.ts` pins
this package's own contract against modules written in the idiom `babel-preset-solid` emits, with
no bundler, because a test here cannot import one.

## The browser-backed e2e driver (moved here from `@ultimat3/cli` in 22.0.0)

It was in `@ultimat3/cli`, on the argument that the adapter joined `testing`'s `PageLike` to
`@ultimat3/scraping`'s browser and only `cli` could import both. That stopped being true when the
browser became RAW CDP (below): the driver needs `@ultimat3/core` and Bun, nothing else, so it
lives beside the `PageLike` it implements. `cli` imports it over the declared `cli -> testing` edge.

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
| `cdp-launch.ts` | which Chrome, and starting it — the candidate list, the flags, and the endpoint read off its stderr |
| `cdp-connection.ts` | CDP over Bun's own `WebSocket`: request framing, reply correlation by `id`, one-shot event waiters, the per-call deadline |
| `cdp-e2e-session.ts` | the BROWSER half, `E2eSession`: every target auto-attached at browser level and PAUSED until its Network domain is on (a SharedWorker opens its socket at start-up) |
| `cdp-e2e-page.ts` | one TAB, `E2eTab`: `E2eBrowserPage`'s five methods plus `reload`, `waitFor`, `indexedDbNames`, `close`. `offline()` forwards to the session — the switch is browser-wide |
| `e2e-app.ts` | `startE2eApp({ root, mode, seed })`: reset + seed + spawn on a THROWAWAY `ULTIMATE_STATE_DIR` and free ports, `/readyz`-gated, spawned through the app's own `@ultimat3/cli` bin (`xBin`); `stop()` removes the directory |
| `e2e-preload.ts` + `e2e-browser-handle.ts` | the `e2e` step's preload (`@ultimat3/testing/e2e-preload`): with `ULTIMATE_E2E_ROOT` set it spawns the app, opens ONE browser, installs its first tab, and publishes `e2eBrowser()`, `e2eApp()`, `e2eBaseUrl()` |
| `packages/cli/src/verify-e2e.ts` | `withE2eApp` (cli's): in an app on a machine with Chrome, the `e2e` step runs the suite with that preload; otherwise exactly as before |
| `cdp-errors.ts` | one constructor per way the browser half refuses |

**Absent by default.** Nothing here runs until `installE2eDriver` is called, so `hasE2eDriver()`
answers `false` and the gate's `e2e` step refuses rather than passing over a browser it lacks.
GitHub-hosted `ubuntu-latest` ships Chrome at `/usr/bin/google-chrome`.

**Raw CDP over Bun, no dependency.** A launched Chrome is driven over its debugging PIPE
(`cdp-pipe.ts`); a remote one over Bun's `WebSocket` (`cdpConnect`). `x shot` and the dev MCP
server's `ui.*` tools launch on the same `launchChrome` since 22.0.0
(`packages/cli/src/cdp-shot-driver.ts`) — one launcher, one wire. A CDP event listener is handed
the event's `sessionId` (`CdpEventListener`), so a subscriber owning one page ignores the rest.

**The load EVENT is the completion signal, never `Page.navigate`'s reply** — Chrome drops the reply
when a navigation swaps the render process. The waiter goes up before the send; the reply is read
only for `errorText`.

**Every call is deadlined, and a close settles every call in flight.** Four codes, four repairs:
`X_CDP_BROWSER_MISSING` (install one), `X_CDP_LAUNCH_FAILED` (read its stderr, in the cause),
`X_CDP_CALL_FAILED` (look at the page), `X_CDP_TIMEOUT` (raise the deadline).

**`evaluate` is the lossy edge.** Only `Function.prototype.toString()` crosses: a zero-parameter
closure over page globals works; native, bound, parameterised and method-shorthand closures are
refused statically; a missing binding comes back named from the page's own `ReferenceError`.

**`update()` still refuses** — a second build under a new build id is a SERVER fact no page port
can speak for. `offline()`/`online()` forward to `E2eBrowserPage.offline`.

The reasoning behind every rule above, verbatim, is [`docs/history/testing.md`](../../docs/history/testing.md).

