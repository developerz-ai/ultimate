# 02 — Bug closures: flakes, compat, test discovery, telemetry identity, scroll chaining, advisory

> Part of [`overview.md`](overview.md). Depends on: none. Tiers: 0 (`core`), 4 (`ui`, `render`), 5 (`cli`), `scripts/`. Closes #1372, #1285, #1239, #1287, #1361, #1289, #1221, and the `x dev` row-security migrate stub (red "no stub" row in `scripts/finished.ts`).

## Files to change

| Issue | File | Change |
|---|---|---|
| #1372 flake | `packages/cli/src/app-load-install-fix.test.ts:282` | `mkdirSync(join(root,'node_modules'),{recursive:true})` before the symlink (sibling at `:173` does it). Order-dependent under `--randomize`: the `test.each` at `:311` `reset()` deletes `node_modules`. |
| | same file `:242`, `:305` | `rmSync(…, { force: true })` in `finally` so a cleanup ENOENT never masks the real error (that masking is what the issue log shows) |
| #1285 flake | `packages/cli/src/cmd-db-migrate-dev.test.ts:59-118` | Tests share ledger state: the rollback test (`:91-118`) ends by re-applying `0001_gadgets` (`:115-117`), so if it runs first, test 1 writes byte-identical SQL, `X_APP_MIGRATIONS_UNAPPLIED` never fires, `untilGeneration` (`:66`) times out. Give each test its own migration (`0001_gadgets`, `0002_widgets`). Fixture: `cmd-dev-boot-fixture.ts`. |
| #1239 compat bun-latest | `packages/cli/src/heavy-ledger.test.ts:228` | Race in the test, not the ledger (FIFO at `heavy-ledger.ts:294`): children append `+ 10 <label>` after `reserve()` returns (`:61`). Assert admission order from the ledger itself — `readLedger(...).holds` sorted by `at` — never from child output (waiting on `held` does not order the children's appends). |
| #1287 | `packages/cli/src/test-ignores.ts:17` | add `.claude/worktrees` to `IGNORED_AT_ROOT` (both projections follow); keep `.claude/hooks/*.test.ts` discovered (`test-ignores.test.ts:55`); optionally `test-housekeeping.ts:63` `NEVER_WALKED`. Drop the `needs-repro` label. |
| #1361 | `packages/cli/src/serve-boot.ts:194,222` | configure telemetry **before `loadAppConfig`** from env alone (`OTEL_SERVICE_NAME`, else `service.name` in `OTEL_RESOURCE_ATTRIBUTES`), so boot spans carry it; after `loadAppConfig`, fill in `appConfig.name` only when neither env source set it (precedence `OTEL_SERVICE_NAME` > `OTEL_RESOURCE_ATTRIBUTES` > app name); version = `OTEL_RESOURCE_ATTRIBUTES` `service.version`, else `BUILD_ID` (`buildIdFor`, `:222`; read the stamped env early so spans during app load carry it), else `APP_VERSION` (`packages/core/src/app-version.ts`) |
| | `packages/core/src/telemetry.ts:148,163` | drop the invented `'ultimate'`/`'0.0.1'` default for `unknown_service` (OTel spec default); `resetTelemetry` resets `resource` (push a release closure onto `acquired`) |
| | `packages/core/src/framework-env.ts:~75` | register `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` (else `X_FRAMEWORK_ENV_UNREGISTERED`) |
| | `wiki/` observability page | precedence: `OTEL_SERVICE_NAME` > `OTEL_RESOURCE_ATTRIBUTES` > app name; version > `BUILD_ID` |
| #1289 | `packages/ui/src/tokens/_mixins.scss:200-202` | remove `overscroll-behavior: contain` from `custom-scrollbar` (Chrome 144+ traps page scroll on boxes with nothing to scroll); fix the comment |
| | `global.scss:52`, `Dialog.module.scss:71`, `Drawer.module.scss:121`, `CommandPalette.module.scss:74`, `SearchableSelect.module.scss:75`, `TimeRangePicker.module.scss:17` | re-add `contain` where trapping is wanted (modal surfaces) |
| | `Table.module.scss:5`, `Tabs.module.scss:33` | `overscroll-behavior-inline: contain` only |
| | `AppShell.module.scss:130` | `.sidebar` contains only under `:popover-open` below `md` |
| #1221 | `scripts/lib/advisory-acknowledged.ts` (new) | **Acknowledged-advisory ledger with expiry.** Rows `{ manifest, dependency, advisories, via, reason, appFix, expires }`. First row: `sass` in `packages/render/package.json:61` (pulls `immutable ^5.1.5` < 5.1.8: GHSA-xvcm-6775-5m9r, GHSA-v56q-mh7h-f735; `source-map-js` < 1.2.2: GHSA-68fv-2mgg-jv7q), app fix `bun update immutable source-map-js`, 90-day expiry; exit condition = sass raises its floors (report upstream). Rejected: render declaring direct floors — an app with an old lockfile can keep `immutable@5.1.5` hoisted for sass while render nests a patched copy, a false green. The repo's own lock is already patched (`bun.lock:985,1057`). |
| | `scripts/lib/advisory-floors.ts:86-112` | `decideFloor` gains an `acknowledged` verdict when every exposure of an unfloorable range is covered by an unexpired row; codes `X_ADVISORY_ACK_EXPIRED`, `X_ADVISORY_ACK_STALE` (row covers nothing) via `bun run new-error-code … --script scripts/advisory-floors.ts` |
| | `scripts/lib/pin-tables.ts` | register the ledger so the `no-exemption-debt` finished row counts it |
| `x dev` stub | `packages/cli/src/dev-db-migrate.ts:44-58` | delete `devCanMigrate`/`assertDevCanMigrate` (`NotImplementedError` at `:52`; grep other callers first). No second session needed: PGlite `reserve()` (`packages/db/src/pglite.ts:383`) holds the turn queue exclusively. |
| | `packages/cli/src/dev-db-migrator-hold.ts` (new) | `withMigratorHold(run)`: reserve the unwrapped client (the `rowSecureClient` proxy passes `reserve` through) → `reset role` → `holdMigratorRole` → `migrate({ client: session, lock: false })` + drift/catalog/storage reads on the same session → `finally` `reset role`, `serveAsAppRole`, `assertRowSecurityBinds`, release. `lock: false` is required (`withAdvisoryLock` would re-`reserve()` and deadlock). If re-assuming `x_app` fails, stop serving — never continue as superuser. |
| | `packages/cli/src/db-rollback-pass.ts`, `row-security-boot.ts` | same hold around `rollback({ client: session, lock: false })`; `reverseApplied` takes a client |

## Steps

1. Agent A (cli tests): #1372, #1285, #1239, #1287 — four files + `test-ignores.test.ts`.
2. Agent B (telemetry): #1361 — core + `serve-boot.ts` + wiki.
3. Agent C (ui): #1289 — SCSS + e2e.
4. Agent D (advisory + `x dev` stub): `scripts/lib/advisory-*.ts`, `scripts/advisory-floors*.ts`, `scripts/lib/pin-tables.ts`, `packages/cli/src/dev-db-*.ts`, `row-security-boot*.ts`, `db-rollback-pass.ts`.
5. Replay each flake with its issue's seed (`bun test --randomize --seed <n> ./<file>`) before and after.

## Tests

- #1372/#1285/#1239: the fixed files themselves; run each 20× with `--randomize` (`for i in $(seq 20); do bun test --randomize ./packages/cli/src/<file> || exit 1; done` — stops failing on the first red run).
- #1287: extend `packages/cli/src/test-ignores.test.ts` `SAMPLES` + dot-dir test.
- #1361: new `packages/cli/src/serve-boot-telemetry.test.ts` (model: `serve-boot-build-id.test.ts`) — config name, `OTEL_SERVICE_NAME` override, `OTEL_RESOURCE_ATTRIBUTES=service.name=worker` alone beats the app name, version = `BUILD_ID`; a span opened inside `loadAppConfig` carries the env-supplied name (spans before config can only carry env sources — assert exactly that). `bun test ./packages/core/src/telemetry.test.ts`.
- #1221: `scripts/advisory-floors.test.ts` fixtures for `acknowledged`, expired, stale.
- `x dev` stub: extend `packages/cli/src/dev-row-security.test.ts` — migrate while serving; new table owned by `x_migrator`; tenant A still sees 1 of 2; a concurrent read during the pass never sees 2. New `dev-db-migrator-hold.test.ts` — a failing migration leaves `current_user = x_app`.
- #1289: new `packages/cli/e2e/ui-scroll-chain.e2e.test.ts` — wheel over sidebar and over a table on a tall page ⇒ `scrollY` moves; an open `Drawer` still traps. Fails only on Chrome ≥ 144: assert the CI browser version in the test or it can't fail.

## Done when

- Each issue closed by its PR (`Closes #…`); #1239 closed by the next green `compat.yml` bun-latest cell.
- `bun run scripts/finished.ts --check --json`: "no stub" and "supported range is tested" rows green.
- 20 randomized runs of each flaky file green.
- `bun run verify` green.
