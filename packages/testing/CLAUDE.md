# @ultimat3/testing — boundary

Tier 5. May import tiers 0–4. Imported by every package's tests and by generated apps.

Deps: `core` (tier 0), plus `time`, `jobs` and `mail` — imported **dynamically inside the fixture
factories only**, so a test that never destructures `mail` never loads the mail package.

| Rule | Detail |
|---|---|
| No mocks of the DB | clone a template database; `template-db.ts` is the only DB path |
| No wall clock | `frozenClock` / `advanceClock`; `Date.now()` is frozen by the preload |
| No unmocked egress | `sealed-network.ts` patches fetch; a miss is `X_TEST_NETWORK_SEALED` |
| Self is not egress | a port core's `markListening()` announced passes through — a socket test never unseals |
| No retries | a flake is fixed or deleted the day it flakes; there is no `retry: 3` |
| Test names | always via `testName(type, name)` so `x verify` can filter them |
| Injection | `SqlRunner` and `connect` are parameters, so unit tests need no server |
| Fixtures | the preload registers `clock`, `mail`, `runJobs` — an app registers the rest |
| Registry hygiene | the fixture registry is process-global; a test that clears it snapshots with `fixtureSnapshot()` and hands it back in `afterAll` |

Commands: `bun test`, `bunx tsc --noEmit -p tsconfig.json`.

Entry points: `.` (the API) and `./preload` (side effects for bunfig).
