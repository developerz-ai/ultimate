# 08 — Windows: contributors, app developers, Windows hosts

> Part of [`overview.md`](overview.md). Depends on: 07 merged (07 T8 deletes root `bin/`). Tier: 0–5 + CI.
> **Sweeps 8a → 8b.** Audit at `d7b8c7fa`, 2026-10-04, by reading the code; **[verify]** rows rest on
> Bun-on-Windows behaviour and are confirmed on the `windows-latest` job before being fixed.

## Rule
Native Windows (PowerShell/cmd, no WSL) is a supported platform for **all three** of:
1. contributing to the framework;
2. building an app (`x new` → `x dev` → `x verify` → `x build`);
3. running an app on a Windows host: the Linux image under Docker Desktop (axiom 7 unchanged).
   A Windows binary as a service (`x build --target binary --platform bun-windows-x64`) is **not** a
   supported deploy unless owner O-win changes axiom 7. Until then W8 is for dev/CI cross-compile
   and local runs only.

Enforced by a `windows-latest` CI job (axiom 3). It runs every step in PowerShell, so a bash dependency that comes back fails the job.

## State (As of 2026-10-04)
- **No Windows support today:**
  - `docs/idea/15-risks.md:50` says "dev via WSL".
  - All 7 CI jobs run on `ubuntu-latest`.
  - `scripts/ci-workflow-shape.test.ts:284-290` refuses any other runner.
- **Already Windows-aware:**
  - `cli/src/path-segments.ts`, `app-transport.ts:70`, `render/src/registry.ts:125`, `app-load.ts:199`, `gitignore.ts:97`.
  - About 30 `\`→`/` conversions.
  - `bun.lock` pins win32 binaries for Biome, TypeScript and @parcel/watcher.
  - No tracked path is longer than 121 characters, and there are no case collisions.

## Sweep 8a — unblock, protect data, enforce (≤ 4 agents)

| Agent | Rows | Exclusive paths |
|---|---|---|
| A — line endings + hashes | W1, W3, W4 | `.gitattributes`, `packages/cli/src/templates/scaffold-db-package.ts` (+ new root `.gitattributes` template), `packages/db/src/migrate.ts`, `packages/cli/src/drift.ts` + tests |
| B — scaffold shell | W2 | `packages/cli/src/templates/{scaffold-docs,scaffold-repo}.ts`, `packages/cli/src/{cmd-new,messages}.ts`, new `bin/*.ts` templates |
| C — repo-root paths | W5 | `scripts/lib/{run,guard-load}.ts`, `packages/ui/src/{sass-probe,catalog/build-catalog,icons/build-icons}.ts`, `packages/cli/src/templates/shipped-guard-fixture.ts`, `packages/cli/src/cmd-dev-fixture.ts` |
| D — CI job | W6 | `.github/workflows/ci.yml` (new `windows` job), `scripts/ci-workflow-shape.test.ts`, `scripts/lib/ci-parts.ts` if needed, `docs/idea/15-risks.md:50` |

| # | Sev | Where | Windows failure | Fix | Test / enforcement |
|---|---|---|---|---|---|
| W1 | Blocker | `.gitattributes` (no `* text=auto eol=lf`); `biome.json:35` `lineEnding: "lf"` | Default `core.autocrlf=true` → CRLF checkout → biome/lefthook flag every file; about 104 `split('\n')` scanners and every byte-exact golden (`framework.manifest.json`, `llms.txt`, schema dumps) mismatch | Add `* text=auto eol=lf` to the repo `.gitattributes`; `x new` writes the same root `.gitattributes` (today it writes only `packages/db/.gitattributes`, `scaffold-db-package.ts:229`) | Windows job: default-autocrlf checkout → `bun run lint` |
| W2 | Blocker | `templates/scaffold-docs.ts:156-200` (`bin/setup`, `bin/dev`, `bin/check` are bash); `scaffold-repo.ts:73,75`; `messages.ts:176` (`cd {name} && bin/setup && bin/dev`); `cmd-new.ts:154` `chmod` | Onboarding fails in PowerShell/cmd | Port each to `bin/<name>.ts` run by `bun run`; package.json scripts point at them; delete the bash files (one way); `cli.new.done` → `bun run setup && bun run dev`; drop the `chmod` | Windows scaffold smoke: `x new` → `bun run setup` → `bun run check` |
| W3 | High (data) | `packages/db/src/migrate.ts:86-87` `checksumOf` = sha256(`text.trim()`) | A CRLF migration hashes differently → an image built from a Windows checkout refuses a database already migrated | Normalise `\r\n` → `\n` before hashing. Existing checksums are unchanged (LF input is byte-identical) | `migrate.test.ts` "CRLF and LF produce one checksum" |
| W4 | High | `packages/cli/src/drift.ts:56-66` `schemaHash` (glob path + text) | **[verify]** `\` paths + CRLF → `X_DRIFT` across OSes | Hash `/`-normalised paths and LF-normalised text | `drift.test.ts` golden hash of a fixture tree, run on both OSes |
| W5 | High | `scripts/lib/run.ts:52`, `scripts/lib/guard-load.ts:59`; `ui/src/sass-probe.ts:20`, `ui/src/catalog/build-catalog.ts:8-9`, `ui/src/icons/build-icons.ts:26,173,238`, `cli/src/templates/shipped-guard-fixture.ts:17`, `cli/src/cmd-dev-fixture.ts:58` | `new URL(..).pathname` gives `/C:/…` and percent-encodes spaces (also wrong on Linux); `repoRoot()` feeds 65 files incl. `scripts/verify.ts:71` → the gate can't find the repo | `Bun.fileURLToPath(new URL(...))`, or `resolve(import.meta.dir, '..', '..')`. **Guard:** `scripts/` rule refusing `.pathname` on an `import.meta.url` URL (`X_URL_PATHNAME_AS_PATH`) | `scripts/lib/run.test.ts` `repoRoot()` equals the repo on Windows; guard test |
| W6 | — | `scripts/ci-workflow-shape.test.ts:289`; `.github/workflows/ci.yml` | No Windows job; the test refuses one | Allow `windows-latest` (free on public repos). New `windows` job, ≤ 25 min, PowerShell steps. **Steps:** checkout (default autocrlf), setup-bun (pinned), `bun install --frozen-lockfile`, `bun run lint`, `bun run typecheck`, a path-heavy unit subset (`packages/core`, `db/src/migrate.test.ts`, `packages/policy`, `packages/render`, `scripts/lib`, `cli/src/{app-load,drift,app-boundaries,path-segments}.test.ts`, `testing/src/cdp-launch.test.ts`), scaffold smoke (`x new` → `bun run setup` → `x verify --json` → `x build --target binary` → start `.x/app.exe`, poll `/healthz`, stop). **Growth:** the subset grows with each fix; truly POSIX-only tests get `skipIf(process.platform === 'win32')` with a reason. Today 48 test files hard-code `/tmp` and 8 spawn `sh` — those are the backlog | the job itself; `ci-workflow-shape.test.ts` pins its shape |

## Sweep 8b — binary, browser, processes, paths (≤ 4 agents)

| Agent | Rows | Exclusive paths |
|---|---|---|
| A — binary target | W7, W8, W16 | `packages/cli/src/{cmd-build,cmd-build-spec}.ts`, `templates/scaffold-entries.ts`, `packages/core/src/{lifecycle-signals,bunfs}.ts` (new helper) + tests |
| B — browser | W9, W10 | `packages/testing/src/{cdp-launch,cdp-launch-attempt}.ts`, fix hints in `cli/src/{browser-launcher,shot-browser,mcp-errors,island-capture}.ts` |
| C — dev processes + tools | W11, W12 | `packages/cli/src/{dev-supervisor,dev-child-watch,verify-deadline,dev-lock,dev-live-fixture}.ts` + tests |
| D — path joins, secrets, tsc, misc | W13–W15, W17–W21 | `cli/src/{app-boundaries,boundary-cuts,verify-role-load,verify-role-load-probe,runtime-bindings}.ts`, `policy/src/declaration-site.ts`, `core/src/secrets-store.ts`, `cli/src/secrets-rotation.ts`, `scripts/lib/{test-typecheck,readme-fences}.ts`, `cli/src/scaffold-typecheck.ts`, `scripts/scaffold-first-run.ts`, `cli/src/templates/island-fixture.ts`, `docker/test-services.env`, `scripts/setup.ts`, `render/src/sass-cache.ts` |

| # | Sev | Where | Windows failure | Fix | Test |
|---|---|---|---|---|---|
| W7 | High | `templates/scaffold-entries.ts:40` `import.meta.dir.startsWith('/$bunfs')` | **[verify]** A Windows compiled binary reports `B:\~BUN\root` → app root resolves inside the bundle → registries load nothing | One exported helper `isCompiledBundle(dir)` in core recognising both prefixes; the template uses it | Windows job boots the binary and `/healthz` answers 200 |
| W8 | High | `packages/cli/src/cmd-build.ts:116-129` `binaryArgs`, `cmd-build-spec.ts` | No platform choice; output `.x/app.exe` reported as `.x/app` | New `--platform bun-linux-x64\|bun-linux-arm64\|bun-windows-x64\|bun-darwin-arm64` flag → Bun `--target`; append `.exe` for Windows; `X_CLI_BAD_FLAG` on an unknown platform; `wiki/CLI-Reference.md` row | `cmd-build.test.ts` argv; Linux `scaffold-smoke` cross-compiles windows-x64 and checks the `MZ` header |
| W9 | High | `packages/testing/src/cdp-launch.ts:21-26` (only `/usr/bin/*`) | No `CHROME_PATH` → e2e silently **skipped**, `x shot` refuses (macOS too) | Candidates per `process.platform`: `%ProgramFiles%`/`%ProgramFiles(x86)%`/`%LOCALAPPDATA%` Chrome, Edge `msedge.exe`, macOS `.app` paths; fix hints name them | `cdp-launch.test.ts` fake env; Windows job asserts e2e `ran > 0` |
| W10 | High [verify] | `testing/src/cdp-launch-attempt.ts:99-107,126-131` | `--remote-debugging-pipe` needs fds 3/4 (unproven on Bun-Windows); `process.kill(-pgid)` is invalid → leaked Chrome | Measure first. If the pipe fails, fall back to `--remote-debugging-port=0` + `DevToolsActivePort`. On Windows, kill by pid tree (`taskkill /T /F /PID`) | `cdp-launch.test.ts` against real Chrome on the Windows job |
| W11 | Med-High | `cli/src/dev-supervisor.ts:112-122`, `dev-child-watch.ts:53-60` | `kill('SIGTERM')` kills outright (no drain, PGlite unclean); `ppid` never changes → the child is orphaned holding port + DB | Restart over IPC (`Bun.spawn({ ipc })`: "drain" message, then exit); liveness via `process.kill(expected, 0)` | `dev-child-watch.test.ts` injected `alive()`; Windows live test |
| W12 | Medium | `cli/src/verify-deadline.ts:213,229,271-276` (`/proc`, `ps`), `dev-lock.ts:181-190` (`ss`, `lsof`), `dev-live-fixture.ts:63,86` | Stray workers survive a timeout; `X_PORT_IN_USE` can't name the holder (silent degrade) | Record child pids at spawn (no tool needed); Windows fallback `netstat -ano` / `tasklist /FO CSV` | `verify-deadline.test.ts` injected listing |
| W13 | Medium | `cli/src/app-boundaries.ts:106-108` → `boundary-cuts.ts:115-124`; `verify-role-load.ts:84-86`; `verify-role-load-probe.ts:34` | `relative()` yields `\` → `x fix` writes `import '..\\foo'`, which breaks Linux teammates | `.split(sep).join('/')` (pattern `island-store.ts:81`). **Guard:** a `scripts/` rule — a `relative(` result reaching an import specifier or fix text must pass through the shared `toPosix` helper | `app-boundaries.test.ts` Windows-style input |
| W14 | Medium | `policy/src/declaration-site.ts:13-18` `OWN_DIR = \`${import.meta.dir}/\`` | `\` stack frames never match → wrong declaration site reported | Normalise frame + `OWN_DIR` to `/` | `declaration-site.test.ts` fake Windows frame |
| W15 | Medium (security) | `core/src/secrets-store.ts:25,131`, `cli/src/secrets-rotation.ts:31` | `0o600` is a no-op; the key gets the profile's default ACL; `secrets-store.test.ts:87-116` fails on Windows | On win32, restrict with `icacls <file> /inheritance:r /grant:r "%USERNAME%:F"`; document it in `wiki/Secrets.md` (or the secrets page); mode tests `skipIf(win32)` + an ACL test | `secrets-store.test.ts` on the Windows job |
| W16 | Med-Low | `core/src/lifecycle-signals.ts:14` (`SIGTERM`, `SIGINT`) | Windows never sends SIGTERM: a service stop kills outright | Also install `SIGHUP` (console close) and `SIGBREAK` on win32; document Ctrl-C / Ctrl-Break drain in `wiki/Deployment.md`. Docker Desktop (Linux image) is unaffected | Windows live test: Ctrl-Break → drain log line |
| W17 | Medium | `scripts/lib/test-typecheck.ts:75`, `scripts/lib/readme-fences.ts:173`, `cli/src/scaffold-typecheck.ts:209`, `scripts/scaffold-first-run.ts:40` | Spawn `node_modules/.bin/tsc` with no extension → **[verify]** ENOENT | `Bun.which('tsc', { PATH: join(root, 'node_modules', '.bin') })` | `test-typecheck-gate` on the Windows job |
| W18 | Low | `cli/src/runtime-bindings.ts:70,80` (`pglite://${join…}`, `file://${join…}`); `ui/src/sass-probe.ts:28` | `file://C:\…` is not a URL (works today only by prefix-stripping) | `Bun.pathToFileURL`, or rename to a non-URL prefixed string + doc | unit on Windows |
| W19 | Low | `cli/src/templates/island-fixture.ts:45,49` `symlinkSync(…,'dir')`; tracked symlink `dummy/social-media-clone/AGENTS.md` | EPERM without Developer Mode; with `core.symlinks=false` it checks out as a text file | `'junction'` on win32; replace the tracked symlink with a real file (or a generated copy checked by a drift guard) | island tests on Windows |
| W20 | Low | `docker/test-services.env` (`localhost`), `scripts/setup.ts:96-97` (`set -a; . …`) | `localhost` → `::1` misses the IPv4-only published port; setup prints bash-only instructions | `127.0.0.1`; setup prints PowerShell instructions on win32 | `compose-env-parity.test.ts` |
| W21 | Low | `core/src/secrets-store.ts:132` rename-over (also `render/src/sass-cache.ts:142`, `db/pglite-snapshot.ts:112`, both best-effort) | EPERM/EBUSY when the target is open | Bounded retry with backoff on EPERM/EBUSY for the secrets path | unit with an injected rename |

Not fixed, on purpose: `dev-watch-tree.ts:83` (one handle per directory works); `docker/deploy-proof/run.sh` (a framework-only Linux proof).

## Steps
1. Sweep 8a: branch `feat/sweep-8a-windows`. Brief A–D. D lands the CI job **first** as non-required, so A–C can watch it go green. Once green, make it required. PR, reviews, merge.
2. Sweep 8b: same loop. Each [verify] row: reproduce on the job first, then fix. A row that does not reproduce is closed as falsified in `status.yml`.
3. Docs:
   - `docs/idea/15-risks.md:50`: native Windows is supported, with the gate named.
   - `wiki/Installation.md` + `wiki/Getting-Started.md`: PowerShell instructions.
   - `wiki/Deployment.md`: running on a Windows host with Docker Desktop (the binary-as-service path only if O-win approves it).

## Done when
- The `windows-latest` job is green and required. Its scaffold smoke boots a Windows binary and gets 200 from `/healthz`.
- A contributor on PowerShell runs `bun install && bun run setup && bun run verify` with no WSL. Record the run in the PR.

## Risks
- **Axiom 7 ("containers only"):** a Windows binary run as a service is a non-container deploy. `--target binary` already ships for Linux, so W8 adds a platform, not a second deploy mechanism. **Owner O-win:** default is container-only — Windows hosts use Docker Desktop; W8 is dev/CI cross-compile. A binary-as-service deploy needs an explicit axiom-7 change recorded in root `CLAUDE.md`.
- **CI minutes:** `windows-latest` is about 2× slower. Keep the job ≤ 25 min, and keep the unit subset path-focused rather than the full suite.
