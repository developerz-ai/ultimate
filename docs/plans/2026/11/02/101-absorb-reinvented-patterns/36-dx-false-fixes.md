# 36 — A `fix:` that is false is a bug

> Part of [`overview.md`](overview.md). Depends on: none. Column-drop fix text is [`04`](04-db-migration-safety.md)'s. Tier: 1 (`db`), 2 (`entity`, `http`), 5 (`cli`).

## Why
Axiom 4 says errors are instructions. The `errors` step and `cli/src/fix-command.ts:16` prove a fix names a real command, never that running it helps. Run on a scaffolded app 2026-11-02, these exit 0 or worsen the app. An agent trusts them, so one false line costs loops.

## Fixes
| # | Sev | Site | Failure, as printed | Smallest fix | Failing-first test |
|---|---|---|---|---|---|
| D2 | High | `db/src/migration-ledger.ts:125`, `cli/src/drift.ts` | edit an applied migration's `up`. `x db migrate`: `X_MIGRATION_CONFLICT`, fix `x db gen "fix initial"`. Run it: exit 0, "schema dump rewritten", the tampered column now in `packages/db/schema/04_tables/posts.sql`. `drift`, `manifest` green. On a fresh database: `X_DB_DRIFT`, fix `x db gen "add hacked"`, also a no-op | conflict fix: `git checkout -- packages/db/migrations/<id>.sql   # never edit an applied migration; then x db gen "<change>"`. `X_DB_DRIFT` for a column no entity declares: declare it, or restore the migration and `x db reset`. Rail below | `cli/src/db-fix-truth.test.ts`: the sequence on the scaffold fixture; following the printed line leaves `drift` red until restored |
| D6 | Med | `cli/src/output.ts:173`, `cli/src/cmd-doctor.ts:260`, app load | import of an uninstalled `@ultimat3/mail`: `X_CLI_UNEXPECTED` per load path, fix `x doctor --json`, which says "shippable". The cycle closes on itself | in the app loader, a resolve failure becomes one `X_APP_IMPORT_UNRESOLVED`, deduped by specifier. Bare: `bun add <pkg>`. Relative: edit the import in `<at>`. `doctor`'s `snapshots` probe gains the same scan | `cli/src/app-load-unresolved.test.ts`: both shapes, one finding each, fix runs and the next load passes |
| D4 | Med | `cli/src/app-boundaries.ts:189-193,207` | route imports `../post/repo`: fix `x g query shoplist`. Run it: 14 files and a new entity, table `shoplists`. A plural name is refused, the singular invents | the fix names the slice the import resolves into: `x g query <route-name> --feature post`. No slice resolved: `x g resource <name>` | `cli/src/app-boundaries.test.ts`; `cli/src/generate-fix.test.ts`: running it writes under `post/queries/` and no `entity.ts` |
| D3 | Med | `cli/src/generate-feature.ts:27` | `--feature pst`: fix `x g resource pst` invents a table. For `--feature post`-shaped intent, `x g resource post` conflicts, and that fix is `--force`, overwriting `entity.ts` and `policy.ts` | `cause` lists existing slices; closest by edit distance in the fix: `x g action foo --feature post`. None within distance 2: list only, then `x g resource <name>`. The conflict fix stops offering `--force` on `entity.ts`: names `x g action`/`query --feature <slice>` first | `cli/src/generate-feature.test.ts`: `pst` suggests `post`; no near slice; conflict fix leads with `--feature` |
| D1b | Med | `cli/src/verify-checks.ts:87-89` | `X_LINT_FAILED` fix `bunx biome check --write .`: "Skipped 1 suggested fixes", red. The diagnostics sit in `output`, not `findings` | each biome diagnostic becomes a finding through `--reporter=json`: `at`, rule, message; fix per finding, `bunx biome check --write <file>` when safely fixable, else the rule's name and "edit the line". Template half in [`36-dx-generators`](36-dx-generators.md) | `cli/src/verify-checks.test.ts`: unused variable, finding names file and line; fix never claims a no-op |
| D10 | Low-med | `cli/src/framework-env.ts:87,98`, `cli/src/cmd-env.ts:83` | `x env --json`: exit 1, two dev-secret findings. `x doctor`: "shippable". By design (`framework-env.ts:32`: unnamed means deployed), and said nowhere. Fix `export …` is gone on the agent's next shell call | summary says "checked as production: no ULTIMATE_ENV named". Each finding's fix: a secret store line for production, plus `# this machine: ULTIMATE_ENV=development x env check`. No `export` in a fix | `cli/src/cmd-env.test.ts`: summary states it; `ULTIMATE_ENV=development` exits 0 on the same table |
| D12a | Low | `entity/src/entity-error.ts:147`, `entity/src/view.ts:94` | `$view(['titel'])`: each loader repeats it (3 findings on one load, 29 reported on a larger app), fix `x entities show posts --json` re-fails with the same finding, since that load throws too | a `view` refusal's fix: `edit $view([...]) in <at>   # pick from: id, orgId, …`. Findings deduped by code + cause in `output.ts`, a count beside it. Same file as `$view` issue work in [`10`](10-schema-sensitive-and-rules.md): coordinate | `entity/src/view.test.ts:195` flipped; `cli/src/output.test.ts`: dedupe |
| D12b | Low | `http/src/csrf.ts:108` | fix hardcodes `http://localhost:3000/the-path-above`; `PORT=4000` is not that, and the path is known | `csrfBlocked(pathname, reason, ip, origin)`: real origin and path, from the request | `http/src/csrf.test.ts`: fix names the request's port and path |
| D7 | Low-med | `cli/src/output.ts:209`, JSON result | `x` is not on `PATH`: `command not found`, and every finding's fix starts `x …`. Generators' `next:` already print `bunx x` (`cli/src/cmd-generate.ts:293`) | one `runnableFix(fix)` at the render layer, human and `--json`: a leading `x ` becomes `bunx x `, also after `&&`. Off when `ctx.invocation` names the runner. Throw sites stay `x …`: `fix-command.ts` reads them | `cli/src/output.test.ts`: both renderers; `#` tail and quoted text untouched |
| D13 | Low-med | `cli/src/serve.ts:145`, `cli/src/metrics-endpoint.ts:54,172` | `serve.ts` passes no `whenTaken`, so a second role on one host refuses port 9090 (`:172`), and `X_PORT_IN_USE`'s fix says `METRICS_PORT=9091 x dev --json` on a container role, whose entry is `bun apps/web/server.ts` | the refusal stays: a deployed scrape target must not move. The error takes whether this boot is dev; deployed, the fix is `set METRICS_PORT=<free port> in this role's environment, one per role on a host` | `cli/src/metrics-endpoint.test.ts`: both fixes; deployed names no `x dev`. Read, not run on two roles |

## Dropped
| Finding | Reason |
|---|---|
| column-drop fix omits `--allow-destructive` | [`04`](04-db-migration-safety.md) step 6 prints the whole path and tests it |
| `x g resource order` collision fix | not reproduced: `x g resource order` and `user` wrote cleanly on the scaffold. Bring the sequence |

## The rail for D2
`cli/src/schema-dump-drift.ts`, in the `drift` step, no database: for each table in the newest snapshot, the columns parsed from generated `packages/db/schema/04_tables/<t>.sql` must equal the snapshot's. Different: `X_DB_DRIFT`, new cause "the dump holds a column no migration's snapshot records". A replay would be the honest compare and costs a WASM boot and an initdb (`cli/src/db-schema-dump.test.ts:20`); the dump is already that replay's output. Migrations whose snapshot records hand-written DDL (`checkUngeneratableMigrations`) stay exempt by table.

## The enforcement: a fix is run
`cli/src/fix-truth.test.ts`, unit, on `scaffold-fixture.ts`, 6 rows to start: D1b, D2, D3, D4, D6, D12a. Each row: `{ break, code, then }`: apply a break, assert the code, **execute the printed `fix:`**, run `then`. Passing means green or a stated next refusal; exit 0 with the original failure still present fails the test.
- Not every code. Most fixes need a database, a deploy or a secret, so the table is opt-in.
- `cli/src/fix-command.ts:16` stays: it covers all codes for existence, this covers few for truth.
- Convention enforced by: a code named in a `fix-truth` row with a fix that no longer works is a red `unit` step. A false fix found later adds a row, in the same diff as its repair: `docs/architecture/00-conventions.md`.
- Budget: one scaffold copied per file, generators in process. Target under 20 s; over that it moves to `.job`.

## Files
`db/src/migration-ledger.ts`, `db/README.md`, `cli/src/{app-boundaries,generate-feature,verify-checks,cmd-env,framework-env,output,schema-dump-drift,cmd-doctor,app-load,metrics-endpoint,serve}.ts`, `http/src/csrf.ts`, `entity/src/{entity-error,view}.ts`, tests beside each, `cli/src/fix-truth.test.ts` (new), `wiki/Error-Codes.md`, `wiki/CLI-Reference.md`, `wiki/Troubleshooting.md`, `docs/architecture/00-conventions.md`, `docs/architecture/guards.md` if the guard doc regenerates.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_APP_IMPORT_UNRESOLVED` (new, tier 5) | an app module imports what does not resolve | `bun add <pkg>` or edit the import. `bun run new-error-code X_APP_IMPORT_UNRESOLVED --package cli --title '…' --cause '…' --fix '…'` |
| `X_MIGRATION_CONFLICT`, `X_DB_DRIFT`, `X_FEATURE_UNKNOWN`, `X_LINT_FAILED`, `X_CSRF_BLOCKED`, `X_BOUNDARY_ROUTE_TO_DB`, `X_PORT_IN_USE` | existing | text above. Codes stable; a `fix:` is not API |

## Semver
**Breaking, two rows.** `drift` gains a new red verdict; the exported `csrfBlocked` gains a required `origin`. Fix text and render are patch; `X_APP_IMPORT_UNRESOLVED` replaces an `X_CLI_UNEXPECTED` nobody could act on. `--json`'s `fix` prints `bunx x`: an agent parsing the string for `x ` adjusts.
Upgrading: "`drift` now fails when `packages/db/schema/` holds a column no snapshot records. That app has an edited migration: restore it. A caller of `csrfBlocked` passes the origin."

## Done when
- `bun test packages/cli/src/fix-truth.test.ts` green; each row red before its repair.
- The D2 sequence ends red at `drift`, not green with a poisoned dump.
- `bun run verify`, `scaffold-smoke` green twice per shape, `bun run scripts/reference-app-gate.ts` green.
