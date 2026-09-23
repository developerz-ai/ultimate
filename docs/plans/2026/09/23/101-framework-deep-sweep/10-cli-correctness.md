# 10 — cli correctness

> Part of [`overview.md`](overview.md). Depends on: 01 (secrets write), 09. Tier: 5.

Rule: a `fix:` line reproduces the invocation that failed, with every flag. A command resolves the
app root once, and every input (modules, `.env`) comes from that root. Foreign text is fenced.

## Files to change

| # | Defect | File:line | Change | Semver |
|---|---|---|---|---|
| a | an app whose absolute path contains `.test.` loads zero modules with no finding, so manifest, db gen, policy and i18n all check nothing | `packages/cli/src/app-load.ts:115`, `db-seed.ts:105` | Test the root-relative path, or the basename (`app-boundaries.ts:248`, `drift.ts:72`). Also refuse `X_APP_EMPTY` when an app with an `app.config.ts` registers nothing | patch |
| b | the `X_GENERATE_CONFLICT` fix drops `--feature/--surface/--at`, so running it writes a new slice | `packages/cli/src/generate-write.ts:204`, `cmd-generate.ts:362` | Rebuild the invocation from every flag the caller set, each through `quoteArg` (`shell-quote.ts`) | patch |
| c | `x new`'s conflict fix drops `--dir` and hardcodes `x` | `packages/cli/src/cmd-new.ts:227` | Use `invocationOf(ctx,'new')` plus every flag (the comment at `:191` already says so) | patch |
| d | a name that slugifies to empty (`'!!!'`) scaffolds into the cwd. With `--force`, `git add -A && git commit` commits the user's pre-existing files | `packages/cli/src/cmd-new.ts:204-205,218` | Refuse an empty kebab: new code `X_APP_NAME_EMPTY`, cause `"<raw>" has no letters or digits, so it names no directory`, fix `x new <name-with-letters> [--dir <path>]` (built with `invocationOf` plus the caller's flags). Never auto-commit when the target already existed | patch |
| e | `x g entity BlogPost` writes `app/BlogPost/` while `resource` writes `app/blog-post/`. `x g action ../../../evil` writes outside `apps/` (inside the root) | `packages/cli/src/generate-files.ts:76,87`, `readName` | `sliceDir(surface, kebab(feature))`. Refuse `/` and `..` in `name`/`--feature` with `X_CLI_BAD_FLAG` | patch, with a CHANGELOG note |
| f | `.env*` is loaded from the process cwd while the root is found by walking up, so commands from `apps/web` silently use the embedded DB. `bin.ts:185` hands over to the local CLI ignoring `--cwd` | `packages/cli/src/dispatch.ts`, `bin.ts:185`, `local-cli.ts` | After `requireAppRoot`, load `<root>/.env`, `.env.<env>` and `.env.<env>.local` explicitly (never overriding real env). Pass `--cwd` to `resolveLocalCli` | minor |
| g | `prerender` never clears `out`, so a deleted route's HTML ships | `packages/cli/src/prerender.ts:142-360`, `cmd-build.ts:200-202` | `rm(out,{recursive,force})` at the start, refusing when `out` is the root or an ancestor | patch |
| h | `x db reset` deletes `.x/pgdata` under a live `x dev` | `packages/cli/src/cmd-db.ts:294-303`, `dev-lock.ts` | Preflight the dev lock and refuse with `X_DEV_ALREADY_RUNNING` | patch |
| i | `x dev` ignores `PORT` from the scaffold's `.env.development` because the flag default `'3000'` always wins | `packages/cli/src/cmd-dev.ts:304,319`, `templates/scaffold-env.ts:21` | Flag spec with no default, then `env.PORT`, then 3000 (the `metricsPortFor` shape) | patch |
| j | `x manifest --check` ignores `openapi.json` | `packages/cli/src/cmd-manifest.ts` | Check both files | patch |
| k | unquoted paths in fix lines | `packages/cli/src/cmd-new.ts:242`, `cmd-deploy.ts:245` | `quoteArg`. Slice 14 d's shell-arg rule should then catch the class | patch |
| l | `x build --out rel` resolves against the root, not the cwd, and `runVerify` gets no env | `packages/cli/src/cmd-build.ts:189,194` | Resolve against `ctx.cwd` and pass env | patch |
| m | `startDev` has no boot rollback: a throw after `startServices` leaks PGlite, telemetry and the observer | `packages/cli/src/cmd-dev.ts:120-260` | The `releaseBoot` pattern (`serve.ts:279`) | patch |
| n | a throwing `applies` escapes `runStep`'s catch and aborts the gate | `packages/cli/src/verify-run.ts:148` | Wrap `applies` and report it as that step's failure | patch |
| o | the MCP `ui.shot/inspect/interact` tools skip `readRoute`, so `'/\\localhost:9200'` against `/:slug` navigates to another local service | `packages/cli/src/mcp-ui.ts:57`, `cmd-shot.ts:125`, `mcp-ui-interact.ts:209` | Run `readRoute` inside `assertBudgetedRoute` so every caller goes through it | patch |
| p | `syncI18nIndex` overwrites the app's `packages/i18n/src/index.ts` with a template hard-coding `default:'en'` and `import en.json`. It runs after every `x g` and `x i18n add/sync` | `packages/cli/src/i18n-index.ts:35`, `templates/scaffold-i18n.ts:35-38,78`, `cmd-generate.ts:114`, `cmd-i18n.ts:195,273` | Rewrite only if the file equals the template output for some locale set. Otherwise add the missing entries, or refuse with a finding naming the edit. Keep the declared `default`, and never import a missing `en.json` | patch |
| q | `x ci` returns `X_*`/`fix:` blocks reconstructed from raw CI logs as ordinary findings, a prompt-injection path with a shell attached | `packages/cli/src/ci-log.ts:81`, `cmd-ci.ts:144` | Tag `source:'ci-log'` and fence the fix and tail lines with `commentBlock` (`cmd-pr.ts:219-235`) | minor |
| r | `x secrets rotate` seals `secrets.enc.json` with the new key before writing the key file, so a crash between the two loses every secret | `packages/cli/src/cmd-secrets.ts:259-261` | Write the new key to `<key>.next` (01 c's atomic write), seal, then rename the key into place. On start, if `.next` exists, try both keys | patch |
| s | the `SIGINT`/`SIGTERM` listeners in `x secrets edit` stop the signal terminating the process (suspected impact) | `packages/cli/src/cmd-secrets.ts:161-162` | After `shred`, re-raise the signal (`process.kill(process.pid, sig)` once the listener is removed) | patch |
| t | e2e preload leaks the `x dev` child when the browser fails to open. The CDP socket is not closed on handshake timeout | `packages/cli/src/e2e-preload.ts:20-32,55`, `cdp-connection.ts:96-112` | try/catch → `app.stop()` (the `cdp-browser.ts:357-363` pattern). `socket.close()` on timeout and error | patch |
| u | `mcp-ui-diff` checks `out` lexically only, so a symlinked dir writes outside `.x/shot` | `packages/cli/src/mcp-ui-diff.ts:102-106` | realpath `dirname(out)`, as `readCapture` does | patch |
| v | the `test.run` filter becomes a `bun test` flag when it starts with `-` | `packages/cli/src/mcp-host.ts:253` | Refuse a leading `-`, or insert `--` | patch |
| w | the drift cause reads `table "customers" on table "customers"` | `packages/cli/src/schema-diff.ts:41` | Fix the wording | patch |
| x | **root cause of #474.** The harness sets `ready` after fonts and 3 quiet frames and never clears it, while the island mounts on the `idle` strategy (up to 2000 ms of `requestIdleCallback`, `render/src/hydrate.ts:38,145`), which is not counted as activity. `settleReadiness` stops on `ready`, so a busy CPU reports "did not finish mounting" with the window unused | `packages/cli/src/shot-settle.ts:385`, `island-harness-script.ts:152-159` | Poll until `mounted \|\| failed !== null` within the window, and start the quiet-frame count only after `data-x-mounted`/`data-x-failed`. Close #474 | patch |
| y | a failed island capture passes because an **old PNG** exists: `missingShots` only checks existence, and nothing clears the output dir | `packages/cli/src/island-shot.ts:315-324,373` | `missing` = expected targets minus files **this run** wrote; delete each target before capture | patch |
| z | generator names that are JS reserved words or start with a digit (`x g action delete`, `x g entity 2fa-code`) write files that do not parse | `packages/cli/src/generate-kinds.ts:108` (`readName`), `templates/naming.ts:111` | Refuse `X_CLI_BAD_FLAG` when `camel(name)` is not a valid, non-reserved identifier; the fix suggests a suffixed name | patch |
| aa | `offline(true)` twice registers the script twice and keeps one id, so `online()` never restores `navigator.onLine` on new pages | `packages/cli/src/cdp-offline-script.ts:254-270`, `cdp-e2e-session.ts:135-147` | `add` is a no-op when the session is already held | patch |
| ab | `page.evaluate` accepts `function (a) {…}` (the regex requires a name), and the parameter arrives `undefined` | `packages/cli/src/e2e-evaluate.ts:121` | Optional name group | patch |
| ac | `getByRole('textbox')` misses `<input>` with no `type` | `packages/cli/src/e2e-selection.ts:62` | Add `input:not([type])` | patch |
| ad | `ui.interact`'s password guard covers `type` only; `focus` a password field then `press` ×11 bypasses `X_UI_INTERACT_SECRET_FIELD` (low impact) | `packages/cli/src/mcp-ui-interact.ts:156-170` | Check `document.activeElement` before each `press` | patch |

## Steps
1. Security first: o, q, v, u, d.
2. Then silent-wrong-state: a, p, f, g, r.
3. Register `X_APP_NAME_EMPTY` and `X_APP_EMPTY` with `bun run new-error-code`.
4. Each fix-line row (b, c, k) gets a test that **runs** the printed fix in a temp app and asserts its effect, not just the string.

## Tests
- `bun test packages/cli/src`
- `bun run fix-shell-arg`, `bun run error-render`

## Done when
- `x g action publish --feature post`, run twice, then its printed fix, overwrites the same path.
- Running from `apps/web` uses the root's `.env`.
- `'/\\localhost:9200'` is refused by every `ui.*` tool.
- A hand-edited i18n index survives `x g resource`.
