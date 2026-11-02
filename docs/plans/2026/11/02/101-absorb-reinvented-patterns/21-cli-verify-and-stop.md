# 21 — `x verify` alone is the gate; `x stop` ends this checkout's `x dev`

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 5 (`cli`).

## Why
**Budgets.** Axiom 5 says one command; a fresh tree says otherwise. `x verify` reports `X_BUDGET_UNMEASURED` until `x build --target static` has run (`cli/src/budgets.ts:151`), so the scaffold ships `bin/check.ts` (`cli/src/templates/scaffold-bin.ts:101`) and `docs/architecture/15-adding-a-feature.md` warns "**Not `x verify` alone**". One adopter wrote a 100+ line wrapper to get a green first run.
The other half is a false green: stats from an earlier build are read as current. `budgets.ts:224` only checks the measuring rule, so a heavier island weighs the old bytes until someone rebuilds. CI builds first; a local agent does not.
**Stop.** Two adopters wrote one (129, 210 LOC). `X_DEV_ALREADY_RUNNING`'s fix is `kill <pid>` (`cli/src/dev-lock.ts:118`), which returns before the drain ends, so the next `x dev` refuses again. Agents sharing a box reach for `pkill` and end each other's servers; the lock is the per-checkout answer and nothing reads it for this.

## Decisions
| Question | Answer |
|---|---|
| Against `verify-checks.ts:241`'s objection, cost | it weighs every-run cost. Here only when stats are missing, of an old rule, or older than the newest app source. Measured there: 8.2 s on the demo app, once per edit |
| Same comment, second builder | the step spawns `x build`, the one builder |
| Same comment, `examples/dummy`'s 5.9 s | that was a hard `X_PRERENDER_FAILED`, a build failing, never a timing. Such a run stays red, now under the build's own code and fix, the same as `bun run check` gives today |
| Same comment, `SITE_ORIGIN` | unset is not a failure: `publicOrigin` falls to `site.origin`, then `DEFAULT_ORIGIN` (`cli/src/prerender.ts:139`), warning only on a production build (`:143`). It shapes canonical and og:url, never script bytes, so the weight is the same. The gate's build writes to `--out .x/verify-static`, so a deployable `.x/static` built with the real origin is never replaced. Stats always land in `.x/` (`prerender.ts:440`) |
| Step order | safe. `budgets` is not in `BESIDE_SERIAL_SUITES` (`verify-run.ts:192`), so it never races `e2e` on `dist/` |
| `x verify --build` flag | no: a second way beside the default |
| Freshness | newest mtime of `source-files.ts`'s set against the stats file. Not a content hash: the wrong answer costs one rebuild |
| `bin/check.ts` | deleted from the scaffold, with its `check` script: an alias is a second name for the gate. An existing app's copy still works: fresh stats, no second build |
| Dev services in `x stop` | no. What an app runs beside `x dev` is its own compose file. Lock holder only |
| Which pid | the lock holds the child (`cli/src/cmd-dev.ts:132`). Its exit is not `EX_TEMPFAIL`, so the supervisor returns too (`dev-supervisor.ts:207`) |

Killed from the same candidate, recorded so they are not re-proposed:
| Claim | Finding |
|---|---|
| `x.verify.json` external steps | a second way. A guard already is one: `Guard.check` (`cli/src/guards.ts:33`) is any async function. Probe spawned a failing command from `guards/external.ts`: `guardFindings` returned `[{"code":"X_RUST_LINT","cause":"lint-bad",…,"at":"guards/external.ts"}]`. Deadline covered: `stepTimeoutMs.boundaries` over the 300 s check class, tagged processes killed (`verify-deadline.ts:17`) |
| Worker counts need manual sizing | stale: a memory budget since 22.7 (`cli/src/test-workers.ts:223`) |
| Gate must pin Bun | floor enforced (`X_BUN_VERSION`, `app-root.ts:78`). An exact pin is an app's choice, a one-file guard |

## Files to change
- `packages/cli/src/verify-checks.ts:226` — budgets `run`: measure first when stats are unusable; replace the comment at `:238`.
- `packages/cli/src/budgets-freshness.ts` (new) — pure: stats state and newest source mtime in, `'fresh' | 'missing' | 'old-rule' | 'older-than-source'` out.
- `packages/cli/src/budgets.ts:151` — the no-build `fix:` stays for `x build` failing to write stats, reworded.
- `packages/cli/src/templates/scaffold-bin.ts:11,73,120`, `scaffold-repo.ts:77`, `scaffold-bin.test.ts` — delete `check`. `cli/src/cmd-build.ts:381`, `verify-merge.ts:74`: comments reworded. `error-contract.ts:45` keeps accepting `bin/check`: an app's own script.
- `examples/dummy/package.json`, `dummy/social-media-clone/package.json` — `check` out.
- `packages/cli/src/cmd-stop-spec.ts`, `cmd-stop.ts` (new), `registry.ts` — the command.
- `packages/cli/src/dev-lock.ts:118` — fix becomes `x stop --json`.
- `wiki/CLI-Reference.md:31` and a `## x stop` section, `wiki/CLI-Reference.md:534` (a guard may spawn; set `stepTimeoutMs.boundaries`), `wiki/Error-Codes.md:101,544`, `docs/architecture/15-adding-a-feature.md` step 14, `wiki/Getting-Started.md`, `wiki/Installation.md`, `wiki/Bare-VM.md`, `wiki/Tutorial-01-First-App.md`, `wiki/CI-Parallel-Gate.md`, `docs/architecture/12-generated-app.md`, `docs/idea/00-thesis.md`, `14-roadmap.md`, `21-the-range.md`, `README.md`, `docs/idea/README.md`, `llms.txt`, `packages/cli/README.md`, `packages/cli/CLAUDE.md`. No `examples/dummy` use beyond the script.

## Steps
1. `bun run new-error-code` for each code below.
2. Budgets: state not fresh → `x build --target static --no-preflight --out .x/verify-static --json` through `ctx.runner` (a tagged process, under the deadline). The build's findings are the step's, unchanged, with the build's own `fix:`; a run that built says so in the step output.
3. Budgets deadline: check class is 300 s against builds measured at 8.2 s and 5.9 s (`verify-checks.ts:241`). `stepTimeoutMs.budgets` is the override.
4. Keep `scripts/reference-app-gate.ts` building first: fresh stats, no second build, and the ratchet still pins what a build alone refuses.
5. `x stop [--timeout 30s] [--json]`: `liveDevLock(stateDir)` (`dev-lock.ts:84`). None: exit 0, `{ stopped: false }`, a stale lock left to `preflight`. Else SIGTERM, wait for the pid to leave and the lock to clear, default drain deadline + 5 s. Result `{ stopped: true, pid, port, waitedMs }`.
6. Windows: `kill` is TerminateProcess, no drain (`dev-child-watch.ts:10`). Result says `drained: false`, then clear the lock.
7. Never signal a pid the lock does not name. No `--all`, no port lookup.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_DEV_STOP_TIMEOUT` (off-socket) | the pid outlived the wait | `kill -9 <pid>`, then `x dev --json` (a hard kill's lock is cleared on next boot) |
| `X_BUDGET_UNMEASURED` (existing) | the build ran and still wrote no stats | unchanged code; `x build --target static --json` |

## Tests
- `packages/cli/src/budgets-freshness.test.ts` (unit): each state; equal mtimes are fresh.
- `packages/cli/src/verify-budgets-build.test.ts` (unit, recording runner): no stats spawns one build with that `--out`; fresh spawns none; a failing build's finding reaches the step; a source newer than stats rebuilds.
- `packages/cli/src/prerender-budgets.test.ts`: with `APP_URL`, `SITE_ORIGIN` and `site.origin` unset, an unbuilt app builds, stats are written, and the row's `jsBytes` equal a build with `SITE_ORIGIN` set; `.x/static` is untouched.
- `packages/cli/src/cmd-stop.test.ts` (unit, a real sleeping child in a temp state dir): SIGTERM then gone; nothing running exits 0; a lock naming a dead pid is not signalled; a child ignoring SIGTERM gives `X_DEV_STOP_TIMEOUT`.
- `packages/cli/e2e/stop.e2e.test.ts`: `x dev`, `x stop`, then `x dev --once` boots at once. Command `bun test packages/cli/src/cmd-stop.test.ts`.

## Semver
**Breaking, one row.** `budgets` measures when stats are missing or older than source, so a route over budget that stale stats hid is a new red verdict. A fresh tree's refusal becomes a build; `x verify` can be 8 s slower after an edit. New scaffolds have no `bun run check`; existing apps keep theirs. New command, new code.
Upgrading: "`budgets` no longer trusts stale stats. A route it now finds over budget: shrink it, or raise the budget by the measured figure with the reason."

## Done when
- On a fresh scaffold, `x verify` alone is green with no `.x/build-stats.json` beforehand; `scaffold-smoke` runs it that way.
- Growing an island past its budget with stale stats fails `budgets` with no manual build.
- `x stop` returns only after `x dev` can boot again in that checkout.
- `bun run verify` green.
