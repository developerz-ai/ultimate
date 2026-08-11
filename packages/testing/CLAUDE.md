# @ultimat3/testing — boundary

Tier 5. May import tiers 0–4. Imported by every package's tests and by generated apps.

Deps: `core` (tier 0), plus `time`, `jobs` and `mail` — imported **dynamically inside the fixture
factories only**, so a test that never destructures `mail` never loads the mail package.

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
| Built vs declared | `clock` `mail` `network` `runJobs` are built in-process; `page` `budget` `signIn` `deploy` `subscribe` are declared and wait for a driver (`X_TEST_FIXTURE_UNAVAILABLE`) |
| One seam for drivers | a driver registers over a declaration with `defineFixtures` — merges, last wins. Never a second registration mechanism |
| A driver arrives whole | `defineFixtures` holds every name `Fixtures` declares to its declared type, so a half-built `page` is a compile error at the registration, not a missing method three awaits later |
| Registry hygiene | the fixture registry is process-global; a test that clears it snapshots with `fixtureSnapshot()` and hands it back in `afterAll` |
| Fixture teardown | a fixture that installs process-global state (the ambient job or mail driver) implements `Symbol.dispose` / `Symbol.asyncDispose` and restores what was there; `fixtureTest` disposes in reverse build order even when the body throws |
| Building one by hand | `createRunJobs()` outside `fixtureTest` is not disposed for you — reset the driver in `afterEach`, or the next file in the process inherits your queue |
| Factory strategy | an association is built with the strategy that asked for it: `build()` never reaches a database, `create()` writes the parent first. Never a third strategy |
| One write seam | `usePersister` is the only place `create()` writes. A factory that took a repo argument would put the seam at every call site |
| Factory seeds | derived from the table name unless given, so two entities never draw the same uuid stream. `reset()` cascades into associated parents — a half-reset row is worse than none |
| Shared examples | `behavesLike` calls `describe`, so it goes at declaration scope; bun rejects a `describe` inside a test body |
| Parallelism is opt-in | `bun test` is one process on one database. N databases need `bun test --parallel` or `x test --workers N`. Say which one a claim is about |

Commands: `bun test`, `bunx tsc --noEmit -p tsconfig.json`.

Entry points: `.` (the API) and `./preload` (side effects for bunfig).
