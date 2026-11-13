# 14 — cli: an upgrade that installs what shipped, a doctor that says what is missing, no stub commands

> Part of [`overview.md`](overview.md). Depends on: [`03`](03-db.md) D1 (the slow-statement subscriber it wires), [`09`](09-jobs.md) J13 (`x g cron-job`). Tier: 5, plus one registry in `core` (tier 0).

Apps hand-roll what the framework ships (`keyset()`, `pollEvery()`, row security, 21 shipped guards) because nothing tells them. Axiom 3: discovery is a finding, not a wiki page.

## Findings

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| U1 | P1 | confirmed (read); 4 adopters lack shipped guards | `packages/cli/src/cmd-upgrade.ts:251-266`, `upgrade-gate.ts:190-196`, `upgrade-report.ts:91-93`; `templates/scaffold-guards.ts:56-77` (21 guards) | A hop only *prints* `x g guard <name>` for each missing guard | after `install()` (`:253`), before `runHopGate` (`:264`): write `shippedGuardSource(name)` for each `missingShippedGuards` entry (`doctor-guards.ts:20`), report-only, with a per-guard `baseline` count in `x.verify.json` read by `verify-floor.ts`; `guardFindings` (`guards.ts:191`) is notice up to the baseline, red above. `X_GUARD_OVER_BASELINE`. The baseline may only fall |
| U2 | P2 | confirmed (read); 2 adopters rebaselined by hand | `cmd-upgrade.ts:191-205`, `upgrade-bun-floor.ts` | A Bun-floor hop does not re-measure coverage; Bun 1.4.4 changed function counting, so the hop goes red with `X_COVERAGE_BELOW_FLOOR` | when `bunFrom !== bunTo`: run unit coverage once after install, *propose* the measured floor with a dated `why` in the report (never written silently) |
| U3 | P2 | confirmed (grep) | `cmd-doctor.ts:54-135` | Missing probes: (a) row security off while tenant tables exist and raw `sql` literals touch them (0 of 11 apps set `database.rowSecurity`); (b) verify steps whose inputs exist but are not in the floor; (c) caret `@ultimat3/*` ranges; (d) an app env name on a framework-reserved name; (e) an embedded data directory that will not open (the probe only resolves the package, `doctor-probe.ts:122-125`); (f) redundant indexes ([`05`](05-entity.md) E9) and unused ones (`packages/db/src/db-diagnostics-sql.ts:58` exists, not surfaced); (g) a role that fell back to loading the whole app (`role-load.ts:52-60`, `X_ROLE_LOAD_INCOMPLETE`, logged only) | one probe per file: `doctor-row-security.ts` (extend), `doctor-floor.ts`, `doctor-pins.ts`, `doctor-env-reserved.ts`, `doctor-embedded.ts`, `doctor-indexes.ts`, `doctor-role-load.ts`. Each finding carries the executable fix. (g) is also on `/readyz`'s detail body |
| U4 | P2 | confirmed (grep: ~128 literals, no list) | `packages/*/src` | No registry of the env names the framework reads; one adopter's sealed secret collided with a name the CDN purge reads | `FRAMEWORK_ENV` in `packages/core/src/framework-env.ts` (name → owner package), held complete by `scripts/framework-env.ts` (an env literal read in a package and absent from the registry is red). `app-env.ts` refuses a colliding `envSchema` key: `X_ENV_NAME_RESERVED` |
| U5 | P3 | confirmed | `packages/cli/src/cmd-planned.ts:25-86` | Eight registered commands exit `X_NOT_IMPLEMENTED`: `cache`, `branch`, `status`, `logs`, `token`, `ai`, `money`, `config` (axiom 9: never leave it) | ship four whose parts exist: `x token` (over `packages/auth/src/api-keys.ts`, `builtin-adapter.ts:423`, scopes at `mcp-host.ts:78`), `x config` (`loadAppConfig`, secrets redacted), `x logs` (`dev-traces.ts`, `mcp-host.ts:293` `tailLogs`), `x cache` (admin `dev/panel-cache.ts`, `graphSnapshot()`, `invalidateTags`, `flushProcessTiers`). `status`, `branch`, `ai`, `money`: owner decision OD3 in [`90`](90-owner-decisions.md) — ship or remove from the registry; none stays a stub |
| U6 | P3 | confirmed (read) | `packages/cli/src/generate-kinds.ts:15-35` | All 8 primitives have generators; of ~25 `PRIMITIVE_FACTORIES` only `backfill` does | `x g <factory>` for the app-facing ones (`cron-job`, `webhook`, `webhook-receiver`, `rollup`, `purge`, `import`, `export`, `llm`, `agent-job`), each emitting the one call through `generate-files.ts`. A test holds the list against `PRIMITIVE_FACTORIES` with an explicit "no generator, because" column |
| U7 | P3 | confirmed (read; production: the same warnings in all 5 roles on every boot) | `packages/cli/src/serve-boot.ts:170,186` | Boot warnings are not role-filtered (`warnIfIdempotencyProcessScoped()` runs in worker, scheduler, sync) | each boot warning declares the roles it concerns; the app-facing `bootWarning({ roles })` helper uses the same table |
| U8 | P2 | confirmed (read; production: `select $1` is the most-called statement, 38,195 in 26 h) | `packages/cli/src/runtime-services.ts:177-200` (`probedReadinessCheck`), `:383` | `/readyz` answers the previous result but starts a new ping on every call once the last finished | a minimum refresh interval (`READINESS_PROBE_MIN_MS`, 1,000) on the cli clock seam |
| U9 | — | wiring | `packages/cli/src/runtime-*.ts` | [`03`](03-db.md) D1 and [`06`](06-http.md) H6 need a subscriber installed per role | wire `slowStatementLog` and the slow-request line in the runtime, thresholds from config |
| U10 | P3 | plausible (one adopter, 2026-09) | `packages/cli/src/dev-boot.ts` | An embedded data directory that will not open is left for the developer; two set-aside directories sit in one adopter | detect at dev boot, set aside with a dated suffix, re-migrate, say so: `X_DEV_DATA_UNOPENABLE` (a notice with the path, not a refusal) |
| U11 | P3 | absent (catalogue) | — | No way to profile a route or explain a declared query from the CLI | `x explain <query> [--input …] --json`: the query's SQL through `packages/testing/src/plan-oracle.ts` on the dev database. `x profile <route>`: only after a ten-line probe of what Bun's profiler exposes; if nothing usable, record and drop |
| U12 | P2 | plausible (lead, unproven) | `packages/cli/src/role-load.ts:37,52-60`; `serve-boot.ts:40-44` | A deployed adopter idles at 250–320 Mi per role (the demo: 56–73 Mi) and boots in 8 s with a 4–6 s silent gap. Leads: the partial role load fell back to the whole app; no prebuilt registry (`X_IMAGE_NOT_PREBUILT`); `BUILD_ID` unset on a background role imports every page | U3(g) makes the fallback visible. A boot timeline line per role (`boot.phase {name, ms}`) closes the silent gap. The app-side diagnosis is [`44`](44-adopter-e.md) E14 |

## Files to change
- `packages/cli/src/cmd-upgrade.ts`, `doctor-guards.ts`, `guards.ts`, `verify-floor.ts`, `upgrade-report.ts`, `coverage-floor.ts` — U1, U2.
- `packages/cli/src/cmd-doctor.ts` + the seven `doctor-*.ts` files — U3.
- `packages/core/src/framework-env.ts` (new), `scripts/framework-env.ts` + test (new), `packages/cli/src/app-env.ts` — U4.
- `packages/cli/src/cmd-token.ts`, `cmd-config.ts`, `cmd-logs.ts`, `cmd-cache.ts` (new), `cmd-planned.ts`, the command registry; `wiki/CLI-Reference.md` — U5.
- `packages/cli/src/generate-kinds.ts`, `templates/generate-*.ts` (≈ 9 new) — U6.
- `packages/cli/src/serve-boot.ts`, `runtime-idempotency-scope.ts`, `runtime-services.ts`, `role-load.ts`, `dev-boot.ts`, `cmd-explain.ts` (new) — U7–U12.
- Coordinator only: codes via `bun run new-error-code` (`X_GUARD_OVER_BASELINE`, `X_ENV_NAME_RESERVED`, `X_DEV_DATA_UNOPENABLE`), `docs/architecture/guards.md` via `guards-doc.ts --write`, changelog + `wiki/Upgrading.md`, `bun run manifest`.

## Steps
1. With sweep 13a: U1, U2, U3, U4 (the discovery rail). With sweep 13b: U5, U6, U7–U12.
2. U1 is proven on a fixture app pinned one release back: the hop writes the new guard, the gate is green at the baseline, one more violation is red.
3. U4: build the registry from the grep first; the guard then holds it. Names the framework reads through a prefix (`S3_*`) are registered as prefixes.
4. U5: every new command has `--json`, a `wiki/CLI-Reference.md` row and a coded refusal outside an app (`X_NOT_IN_APP`). `x token` never prints a secret twice and never logs one.
5. U6: the generator list test fails when a new `PRIMITIVE_FACTORIES` row has neither a generator nor a reason.

## Tests
- `packages/cli/src/cmd-upgrade.test.ts` — a hop into a release with a new guard writes it report-only; a Bun-floor hop proposes a floor.
- One fixture per doctor probe; each fix command runs verbatim in the fixture and clears the finding.
- `scripts/framework-env.test.ts` — an unregistered env literal is red; `packages/cli/src/app-env.test.ts` — a colliding key refused.
- `packages/cli/src/cmd-token.test.ts`, `cmd-config.test.ts`, `cmd-logs.test.ts`, `cmd-cache.test.ts` — `--json` shape; secrets redacted.
- `packages/cli/src/runtime-services.test.ts` — 10 readiness reads within 1 s send 1 ping. `serve-boot.test.ts` — a worker logs no web-only warning.
- Command: `bun test ./packages/cli/src/<file>.test.ts`.

## Done when
- `x upgrade` on each adopter installs every missing guard with a baseline and leaves the gate green.
- `x doctor --json` on adopter E's shape reports row security, the unfloored steps and the role-load fallback, each with a fix that runs.
- `cmd-planned.ts` is empty or gone.
- An app env key named like a framework one is refused at boot and at `x verify`.

## Outcome (13a, local)

Ships as 31.16.0. `As of 2026-11-12`, before release. U5–U12 are sweep 13b's.

| ID | Outcome |
|---|---|
| U1 | **partial.** A hop installs each missing shipped guard through the installed CLI's own `x g guard <name>` (`upgrade-guards.ts`) and keeps it when `x verify --only boundaries` finds nothing more; one the tree already breaks is taken back out and listed in `data.guards.withheld` with its finding count. App-edited guards (`differs`) are never touched. **Deferred:** the per-guard `baseline` in `x.verify.json` and `X_GUARD_OVER_BASELINE` (`guards.ts`, `verify-floor.ts`), which would let a withheld guard install at its baseline — until then a broken-by-the-tree guard is withheld rather than installed red |
| U2 | shipped, written rather than proposed. A hop that moves the Bun floor runs `x verify --only unit` once (`upgrade-coverage.ts`); only an `X_COVERAGE_BELOW_FLOOR` moves the floor, the number that fell alone, to `floorFor(measured)` (`coverage-floor.ts`, now shared), with a dated `why` — in the hop's diff and `data.coverage`, never silently. Written because a proposal leaves the hop red, which is the defect |
| U3 | **partial.** Shipped (a) `X_DB_ROW_SECURITY_OFF` (`doctor-row-security.ts`: raw `sql` / `Bun.sql` outside migrations, seeds and tests naming a tenant table while `database.rowSecurity` is off), (b) `X_VERIFY_STEP_UNFLOORED` (`doctor-floor.ts`; `e2e` never proposed), (c) `X_FRAMEWORK_PIN_RANGE` (`doctor-pins.ts`), (d) `X_ENV_NAME_RESERVED` (`doctor-env-reserved.ts`). **Deferred:** (e) an embedded data directory that will not open — the probe has to open it, which takes PGlite's single-writer lock the next command needs; it lands with U10's dev-boot set-aside in 13b. (f) unused indexes — `db-diagnostics-sql.ts` reads `pg_stat_user_indexes`, meaningless on a dev database; with [`05`](05-entity.md) E9's doctor report in sweep 18. (g) the role-load fallback — logged by the boot, invisible to a static doctor; with U12's boot timeline in 13b |
| U4 | **partial.** `FRAMEWORK_ENV` / `frameworkEnvEntry` (`packages/core/src/framework-env.ts`): 113 entries (48 contract, 31 switch, 23 internal, 11 host; 2 prefixes). `scripts/framework-env.ts` (`bun run framework-env`, enforced by its real-tree test in the `unit` step) refuses an unregistered literal read (`X_FRAMEWORK_ENV_UNREGISTERED`) and a stale entry (`X_FRAMEWORK_ENV_STALE`). Premise corrected: "~128 literals" is 93 literal reads of 55 names in shipped `packages/*/src` (fixtures excluded); the rest of the registry is names read through constants. **Deferred:** `app-env.ts` refusing a colliding `envSchema` key at boot and at `x verify` is a refusal an existing app meets — `next` (X_BREAKING_ON_MAIN); on `main` it is `x doctor`'s finding |

## Outcome (13b, local)

Ships as 31.17.0. `As of 2026-11-12`, before release.

| ID | Outcome |
|---|---|
| U5 | **four shipped**, plus U11's `x explain`: `x token create\|list\|revoke` over `@ultimat3/auth`'s key store, `x config show`, `x logs tail`, `x cache graph\|bust\|clear`. Still planned, each with its reason in `cmd-planned.ts`: `x token grant` (a key's scopes are never widened), `x cache stats` (hit rates live in the serving processes), `x status` (needs a build-id aggregate the realtime package does not keep), `x branch`, `x ai`, `x money`. OD3 (drop `branch`/`ai`/`money` from the registry) is **parked for `next`**: changing what `x` answers is breaking |
| U6 | **partial, 3 of 9.** `x g cron-job`, `x g purge`, `x g webhook-receiver`, each compiled in the fresh-scaffold typecheck fixture; `FACTORY_GENERATORS` (`generate-factories.ts`) records every factory's generator or the reason it has none — `exportRows`, `importRows`, `rollup`, `webhook`, `llm`, `agentJob` deferred with theirs |
| U7 | shipped. `serve-boot-warnings.ts`: one table of the roles each boot warning concerns, run after load for the booting role alone; `role-start.ts`'s no-authenticator (web) and per-process rate-limit store (web, worker, sync — once per process) warnings read it too. `boot.phase { role, name, ms }` per phase (`serve-boot-phases.ts`) |
| U8 | shipped. `probedReadinessCheck` starts at most one ping per `READINESS_PROBE_MIN_MS` (1 s) however many pollers ask (`runtime-services-readiness.test.ts`) |
| U9 | **already wired** (`otlp-export.ts:81`, every production boot). Added: `database.slowStatementMs` in `app.config.ts` (default unchanged at 500 ms, `0` off, screened by the config validator and `finiteOption`) |
| U10 | shipped. `dev-boot-data-dir.ts`: a directory that exists and will not open is renamed `<dir>.unopenable-<UTC>`, the boot starts an empty one and says so (`X_DEV_DATA_UNOPENABLE`) |
| U11 | `x explain <query>` shipped: the query run once on the dev database, the statements it actually SENT captured off `db.statement` and planned by `sweepPlans` (`explainQuery`'s SQL is logical, so it plans what was sent). `x profile` **deferred**: buildable on `bun:jsc`, needs an in-process app boot |
| U12 | **measured, lead did not reproduce.** Idle RSS on the reference app: web 149 MB, sync 135, worker 114, scheduler 117; the replicator not measured (no logical WAL locally). The 250 MB / 3.7 s silent gap is an unstamped `BUILD_ID` compiling stylesheets on a cold worker (+33 MB warm, 562 ms) — the role-load fallback to a whole-app load did not reproduce. The lead for adopters: stamp `BUILD_ID` in the image. `boot.phase` lines now name the gap |

Ledger: a core `bootWarning({ roles })` helper for apps' own boot warnings.
