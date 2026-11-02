# 17 — The handle follows the migrated test database

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 2 (`entity`), 1 (`db`), 5 (`cli` scaffold, docs).

## Why
The migrated-database half already shipped: `migratedDatabase` (`cli/src/test-database.ts`) and `reusableDatabase` (`testing/src/reusable-database.ts`), PGlite restored from a template, recipe at `wiki/Testing.md:38`. No new fixture, suite or runner is needed. What remains is a hole in that recipe. The scaffolded handle picks its driver once at module load, and `storeMode` answers `memory` under test (`core/src/store-mode.ts:21`, `cli/src/templates/scaffold-db-client.ts:93`), so `setDbClient` moves raw SQL and not the handle. Reproduced 2026-11-02 with the scaffold's `selectDriver` and the recipe's `setDbClient`:

`storeMode memory | handle wrote 1 row | raw SQL on the installed client sees [{"n":0}]`

A repo mixing the handle with its join (`wiki/Entities-And-Migrations.md:221` calls that the sanctioned exception) cannot be tested as written. One adopter forked its code on it: 30 `onPostgres()` sites across 25 files, a 273-line runner, 40 Postgres test files.

## Decisions
| Candidate | Outcome |
|---|---|
| `unitTest` gaining a database mode or a `db` fixture | **killed.** A second way to get a test database beside the recipe. `unitTest` stays "no database" (`testing/src/test-types.ts:48`) |
| A SQL emulator in the memory driver | **killed.** A second SQL engine |
| Per-file driver argument | **killed.** `db` is a module constant; code under test imports it. The driver has to follow the client |
| PGlite as a dependency | already an optional peer of `@ultimat3/db` (`db/package.json:39`) and a root devDependency. Nothing added |

## Files to change
- `db/src/client.ts:241` — export `hasDbClient()`, answering whether `setDbClient` installed one. Never builds the lazy default.
- `db/src/index.ts` — its export.
- `entity/src/database.ts:44` — `testDriver()`: memory until a client is installed, Postgres while one is; decided per repository call, since `database()` resolves each repo once (`entity/src/database.ts:103`). `reset()` empties memory only; `transactor()` follows the same answer.
- `entity/src/index.ts` — its export.
- `cli/src/templates/scaffold-db-client.ts:93`, `examples/dummy/packages/db/src/client.ts:41`, `dummy/social-media-clone`'s client — `storeMode(env) === 'memory' ? testDriver() : postgresDriver()`. Production and `x dev` still construct `postgresDriver()` directly.
- `wiki/Testing.md:38` — the recipe now states the handle follows; a row for when to use which suite. `packages/entity/README.md`, `packages/testing/README.md`, `wiki/Upgrading.md` (one-line app edit, optional).
- `examples/dummy/apps/web/app/<slice>/repo.test.ts` — one test over a repo with a real join through the recipe, the proof it works from an app.

## Steps
1. `testDriver(): Driver` holding one `memoryDriver()` and one `postgresDriver()`. `repo(entity)` returns a repository whose every method resolves the target at call time by `hasDbClient()`. A `Proxy` over `Repo` keeps it one line per concept and survives new `Repo` methods with no edit.
2. `afterAll(() => setDbClient(undefined))` returns the handle to memory: the recipe already says so, so a file's database cannot leak into the next file's unit tests under `--no-isolate`.
3. A `.test.ts` that never installs a client is byte-for-byte today's: memory, no PGlite loaded, no WASM cost. The ~1 GB per worker recorded at `wiki/Testing.md:649` is paid only by files that ask.
4. Other `storeMode` seams (idempotency, audit) stay in memory: their stores are not what a repo's SQL reads.

## Error codes
None new. `X_DB_UNAVAILABLE` (existing) when the peer is missing, already raised by `migratedDatabase`'s loader.

## Tests
- `entity/src/test-driver.test.ts`: writes land in memory, install a client, the same handle writes through it (recording client), clear it, memory rows are back. Mutation: resolve the target once and the test fails.
- `cli/src/test-database.test.ts`: with the real template, the handle's insert is visible to raw `select`: the probe, inverted.
- `cli/src/templates/` scaffold test: a fresh app's `selectDriver` under `ULTIMATE_ENV=test` is `testDriver`.
- `x test unit`; `bun test packages/entity/src/test-driver.test.ts`.

## Semver
minor. A scaffolded `client.ts` is the app's copy, so existing apps keep the memory driver until they make the one-line edit.

## Done when
- The probe prints `sees [{"n":1}]`.
- `examples/dummy` carries one such test, green under `x test unit`.
- A test file with no recipe boots no PGlite (asserted by the package not being imported).
