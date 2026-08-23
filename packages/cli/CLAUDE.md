# @ultimat3/cli — boundary

Tier 5. May import tiers 0–4. Nothing imports this except `create-ultimate`.

| Rule | Detail |
|---|---|
| Entry | `src/bin.ts` (`#!/usr/bin/env bun`) — argv, stdout, exit code only |
| stdout | `write-line.ts`'s `writeLine` — synchronous fd 1, never `process.stdout.write`, which truncates at the 64KB pipe buffer when `process.exit` follows. Exported, because `create-ultimate`'s entry point needs the same one |
| stderr | `write-line.ts`'s `writeErrorLine` — the same loop on fd 2, for a line that is not the command's answer. A `CommandResult` declaring `stream: 'stderr'` is routed there by `dispatch.ts`'s `sinkFor`, and `x mcp serve --transport stdio` is the one case: its fd 1 carries JSON-RPC frames, so the `✓ mcp stdio serving 13 tools` line rendered after the loop was a malformed frame. Neither renderer carries `stream`, exactly like `hold` |
| Boot logs under `--json` | `dispatch.ts` calls core's `setLogStream('stderr')` when `args.json` is set, once, for all thirty commands. `x db migrate --json` printed the boot logger's `ultimate migrate applied` and then the command's own object, so `json.load` raised on the second document. A server's stdout stays its log stream; this is the CLI process only |
| Numeric flags | `flag-number.ts` — one reader for `--port` / `--workers` / `--shard`. A bare `Number.parseInt` accepts `4abc` and answers `NaN`, which turned three checks into ones that cannot fail |
| Shell quoting | `shell-quote.ts`'s `quoteArg` — every value the CLI pastes into a `fix:` or a reproduce line, `exec.ts`'s missing-program refusal and `test-shards.ts`'s reproduce command both. A name holding a space or a `;` interpolated bare is an instruction that runs something else |
| Missing positionals | `MissingPositionalError`, never `BadFlagError` (names a flag that does not exist) and never `UnknownCommandError` (says a known command form is not one). Its `example` is a REAL invocation — `x g route <name>` in a shell is a redirect |
| Bare subcommands | `CommandSpec.defaultSubcommand`, **declared**. The parser answered `subcommands[0]` until 1.2.0, so `x db` ran `gen` — the migration GENERATOR — because it sorted first, and `x mcp` started a server. A command with no defensible default declares none and `MissingSubcommandError` refuses the bare form; `parse.test.ts` pins the set at exactly `db` and `mcp`. Its fix is `x help <command>`. Both forms answer now: `--help` is read off the flag loop and `readSubcommand` is SKIPPED when it is set, so `x db --help`, `x mcp --help` and `x pr --help` print usage instead of exiting 1 with this same refusal — which is what they did on every command taking a subcommand until 2026-08 (`parse.test.ts` pins it across the shipped registry) |
| Closed flag values | a flag whose values are a closed set is READ through a function that refuses the rest — `cmd-build.ts`'s `readTarget`, `cmd-deploy.ts`'s `readMethod`, `cmd-routes.ts`'s `readSurfaceFilter`, `cmd-mcp.ts`'s `isTransport`. `=== 'helm' ? 'helm' : 'compose'` made `x deploy --method helmm` a COMPOSE deploy reporting `method: "compose"`, and `--surface App` reported `0 routes` and exit 0 — a typo and an empty table rendering identically. The set is the framework's own where one exists (`SURFACES` from `@ultimat3/render`), never a list restated here |
| App root | `CommandSpec.requiresApp`, **enforced by `dispatch.ts`** before `target.run` — the field's doc said so for 17 commands and nothing read it, so the promise was kept only by each command remembering to call `requireAppRoot` itself. Those 17 calls stay (they hand the command its root, and name subcommands the dispatcher cannot see), but the DECLARATION is what decides, ahead of any check a command makes about its own arguments; `--help` is exempt, because `target` is the help command by then |
| Result helpers | `command.ts`'s `ok()` / `failed()` write `ok` **after** the `extra` spread: the function's name is the verdict and nothing a caller passes can overturn it. Spread last, `failed('verify', '1 of 19 steps failed', { ok: true })` answered `ok: true` and `exitCodeFor` exited **0** on it — a green CI over a red command (`command.test.ts`) |
| I/O | only `dispatch.ts` renders or exits; commands return `CommandResult` |
| Staying up | a command still listening when `run` resolves returns `hold` (`hold.ts`), or `bin.ts` exits out from under it |
| `--json` | every command, no exceptions — same data as the human render |
| Errors | codes + titles in `src/error-codes.ts`, classes in `src/errors.ts`, subclass `UltimateError`, never a bare `Error`. A class may sit beside its one thrower when `errors.ts` has no room under the 500-line ceiling — `db-seed.ts` and `metrics-endpoint.ts` do |
| Subprocesses | only through `exec.ts`, so a test can inject a fake `Runner` |
| Templates | `templates/*.ts` return strings; no fixture files on disk |
| Strings | rendered output through `messages.ts`, missing key renders `⟦key⟧` — see below for what is *not* rendered output |
| Facts | load the app (`app-load.ts`), then project it — never parse source for primitives |

Every fact the CLI reports comes from a framework package: the manifest from
`@ultimat3/manifest`, `openapi.json` from `@ultimat3/action`, the route table from
`@ultimat3/render`, budget units from `@ultimat3/render`, the `/_x` panels from
`@ultimat3/admin`, the MCP tool catalog from `@ultimat3/mcp`, eval coverage from
`@ultimat3/ai`. A check that reimplements one of those here is the bug, not the fix.

`app-evals.ts` is why the `eval` step can apply with no eval suite at all: a prompt no eval
names is `X_EVAL_MISSING`, an eval whose baseline was never recorded is `X_EVAL_BASELINE_MISSING`,
and a skipped step would read as a green gate over untested code. Its third rule runs *before* the
suite rather than beside it — `ULTIMATE_EVAL_RECORD` makes every eval write its own numbers and
pass, so a gate that inherited the flag would rewrite the committed baselines during the run, and
a finding after the fact does not put them back.

`verify-floor.ts` is the suite ratchet, and it is split across two owners on purpose. `runVerify`
judges the **suites**: a step the committed `x.verify.json` names that reports nothing to check is
recorded failed and not skipped, so the failure count, `data.failed` and every step table another
gate parses all carry it. The `manifest` step judges the **file**: a floor that does not parse, or
that names a step the gate does not run, enforces nothing — and a ratchet nobody notices is off is
the false green it exists to close. Nothing writes the file; a gate that edits its own floor
ratchets in both directions.

**"Nothing to check" is two conditions and one code.** `applies` sees the first — no files — and
cannot see the second, because `describe.skipIf` is decided inside the child process: measured with
no `TEST_DATABASE_URL`, `live` is `4 pass, 114 skip` and the step reported green over a suite whose
whole subject is the database. `test-counts.ts` reads bun's own summary back (`parseBunTest`, the
same reader `x mcp`'s `test.run` uses — a second regex over one format is drift), each runner
attaches `StepOutcome.tests`, and a floor step whose `ran` is zero is `X_VERIFY_SUITE_VANISHED`
with `skippedSuiteFinding`'s cause. **Zero, not a ratio**: one real assertion is a suite that runs,
and a threshold would be a number nobody can defend. An absent `tests` is a step that spawned no
test process at all (`eval` answering with declarations alone), which is not the same claim.

`x new` writes an `x.verify.json` (`templates/scaffold-repo.ts`), or the code above is unreachable
in every generated app — the repo shape that grows suites fastest. It names the eleven steps the
scaffold has proved apply, and deliberately not `e2e`: the scaffolded `page.e2e.test.ts` is an
`e2eTest`, which is `test.skip` until the app registers a browser driver, so pinning it would fail
the app's first gate on the scaffold's own placeholder.

`tsconfig-references.ts` is `package-shape`'s fourth rule: **every published workspace is in the
root `references`**. `bun run typecheck` is `tsc -b`, which builds referenced projects and nothing
else, so a package no reference names is one the gate's own `typecheck` step passes over without
reading a line of it — `X_PACKAGE_UNREFERENCED`, whose `fix:` is the exact `{ "path": … }` entry
and the `tsc -b` that proves it took. Private packages are exempt (a generated app's are all
private), and a root that declares **no** `references` array is not judged at all: project
references are opt-in, and a scaffolded app builds through `extends` + `include`.

`workspace-graph.ts` is `package-shape`'s fifth rule: **every cross-workspace import is declared
in the importing workspace's own manifest**. Without it a scaffolded repo's dependency graph exists
only inside `tsc` — imports resolve through the root `tsconfig.json` `paths`, so affected-package
detection, `bun --filter` ordering and "what breaks if I change this" all read manifests and all
answer too small a set (issue #239, found in a real app where a change reaching five packages
reported one). `X_WORKSPACE_DEP_UNDECLARED` names the manifest and the exact line to add. Shipped
source only: a test file's import is not judged, because `packages/*` here declares no
`devDependencies` by design and the root's hoist is what resolves them. A manifest the scan cannot
read is its own finding rather than a silent skip — a skipped workspace is a hiding place for the
very edge the rule is looking for.

`app-agents-md.ts` is why the `manifest` step declares no `applies` at all. The drift half needs
a committed `x.manifest.json` to compare against, but `AGENTS.md` is required of every repo the
gate runs in — so the step always has a question to answer, and gating both halves on the file
that only the first one needs is how `X_AGENTS_MD_MISSING` stayed unreachable while its wiki row
said it fails builds.

## What goes in `messages.ts`, and what does not

`messages.ts` holds the strings a command *renders* — `CommandResult.summary`, `lines`, anything
the human renderer prints. Three things stay inline, deliberately, and a review asking to move
them is answered by this table rather than by a second convention:

| Not in the catalog | Why |
|---|---|
| `CommandSpec.summary` / `.usage` / `FlagSpec.summary` | the spec is the command's declaration, next to the `run` it describes; parsing and `x help` both derive from it. All command modules declare it inline — moving a subset creates two places to look for one command's help |
| `Finding.cause` / `Finding.fix`, and `BadFlagError`'s `reason` | stable machine-readable diagnostics. A `fix:` is copied and run verbatim; a translated one is a broken command |
| Fixed-width table headers (`renderJobTable`, `renderRouteTable`) | column keys, not prose — the widths are computed from them and `--json` carries the same names |

## The introspection commands project registries, they never re-derive facts

| Command | Files | Reads |
|---|---|---|
| `x actions` / `x queries` / `x entities` | `cmd-registries.ts` | the three declaration registries |
| `x jobs` | `cmd-jobs.ts`, `jobs-{driver,report,drain,json,table}.ts` | `@ultimat3/jobs`' own introspection |
| `x tasks` | `cmd-tasks.ts`, `tasks-facts.ts` | `registeredTasks()` + `@ultimat3/time`'s cron resolution |
| `x policy` | `cmd-policy.ts`, `policy-facts.ts` | `@ultimat3/policy`'s `policyMatrix()` over the app's own `Policy` objects |
| `x i18n` | `cmd-i18n.ts`, `i18n-audit.ts`, `i18n-registration.ts` | `@ultimat3/i18n`'s `extractFromFiles` + `auditCatalogs`, then the live catalog registry |

Each pairs a `cmd-*.ts` of CLI wiring with a facts module that takes plain inputs and returns plain
data, so the projection is testable without a `ParsedArgs` — the `cmd-jobs.ts` / `jobs-report.ts`
split, repeated. Tables go through `table.ts`; a second padding helper is the drift it prevents.

`x policy explain` exists because five packages already print it as the `fix:` on an authz denial
(`policy`, `action`, `query`, `http`, `auth`), and `x i18n` because all three of `@ultimat3/i18n`'s
own error fixes name it. A `fix:` line naming a command this build does not ship is the failure
mode `cmd-planned.ts` closes for planned commands and these close for real ones.

`x i18n check` scans source, which the "never parse source for primitives" rule below does not
forbid: a `t()` call is not a primitive and no registry holds it. It uses `source-files.ts`, the
same walk `errors` and `filesize` use, so the three cannot disagree on what the app's source is.

**And then it asks the question the scan cannot answer.** A catalog complete on disk, its keys used
everywhere in source, and an audit of one against the other were all green for an app that rendered
`⟦key⟧` on every page — registration is a side effect of importing the module that calls
`defineCatalogs()`, and nothing imported it (issue #249). `i18n-registration.ts` loads the app
through `loadApp` — the same call `serveApp` makes at boot, so it is the boot's own answer and not a
simulation of one — and compares the catalogs on disk against the live registry, per locale
(`X_CATALOG_UNREGISTERED`). Two conditions, one code: a shipped catalog no module registered, and
no catalog anywhere while source calls `t()` — the second is the vacuous green an app with an
`app.config.ts` and no `packages/i18n/catalogs/` used to get. `loadApp`'s own findings ride along
ONLY when something is unregistered, because "packages/i18n/src/index.ts: SyntaxError" is the
evidence for the gap above it and noise on a pass.

`catalogFindings(root)` is the one composition both callers report: `x i18n check` renders it as a
table with a `registered` column, `x verify`'s **`i18n` step** returns it as findings. One
implementation, so the command and the gate can never disagree about an app.

**The generators emit `useT()` from the app's own catalog module, never `t` from `@ultimat3/i18n`.**
The specifier is `resolveCatalogModule(root)` — `packages/i18n/package.json`'s `name`, read off
disk, because a template is a pure string function and only a package name resolves as an import.
An app with no such package keeps the framework import: emitting one that cannot resolve trades a
wrong idiom for a file that does not compile. This is where the reported bug's idiom came from —
every generated page imported `t` directly, so no page depended on the module that registers.

**A catalog is authored nested and read flat.** `Catalog` (`{ 'nav.home': 'Home' }`) is the
translator's form; the file on disk holds `{ nav: { home: 'Home' } }`, and `parseNestedCatalog`
refuses a dot inside a key — so anything writing a catalog goes through `nestCatalog`
(`serializeCatalog` for `x i18n add|sync`, `templates/catalog-json.ts` for every generator) or it
emits a file `defineCatalogs` rejects at the app's first boot. `merge: 'json'` unions **deeply**
(`json-merge.ts`) for the same reason: `x new` and `x g resource` both contribute under `app`, and
a shallow spread keeps one of them.

## Three commands that reach outside the process, and none of them is a gate step

`x shot`, `x pr` and `x ci` exist because of the one line in the root `CLAUDE.md` that shapes this
whole package: **the primary developer is an AI agent.** An agent cannot open a browser, cannot look
at a running dev server and cannot read the GitHub web UI. It can read a file, and it can run a
command that prints. These three turn each of those into a file and a print.

They are also the only three commands that need something the process does not have — a browser, a
network, a GitHub token — which is why **none of them is a step of `x verify`**, and why that is not
an oversight to be corrected later. A gate that needs a browser goes red for reasons unrelated to the
change, and CI does not install one.

| | Reaches for | Never |
|---|---|---|
| `x shot <route>` | `x dev` on a scratch port, plus the app's own `puppeteer-core` through `@ultimat3/scraping` | the static build — `--target static` prerenders `site/` only, so an `app/` route would photograph the landing page |
| `x pr review\|resolve\|reply` | `gh api graphql`, through the injected `Runner` | `gh pr view --comments`, which shows *issue* comments and not the line-anchored threads that carry the findings |
| `x ci` | `gh run view --log-failed`, one call | a per-job log fetch — the run and all its jobs come back together |

**`verdict.json` names its own blind spots, and that is the design.** `x shot` reports what it could
not observe alongside what it did. A capture tool that silently omits what it cannot see is worse
than one that says so, because the omission reads as a clean result.

**`x shot` reuses a running `x dev` rather than booting a second one.** Embedded Postgres is
single-writer, so a second boot is `X_DEV_ALREADY_RUNNING` and no picture is ever taken. A reused
server's `stop()` deliberately does not clear the other process's lock.

**`gh` is invoked through `ctx.runner`, never `Bun.spawn` directly** — that is what lets every test
supply a reply table and assert the exact argv with no network and no `gh` installed. `GhOptions.fix`
is a **required** field, so shelling out to GitHub without stating a remedy is a type error rather
than a review comment. A GraphQL response is untrusted input and is parsed against a schema, never
cast: a `null` where an id was expected would otherwise become a mutation against `undefined`.

## The `errors` step enforces the error contract

| File | Job |
|---|---|
| `ts-scan.ts` | the masking every scan shares, the `X_*` codes a file declares, and the ones it says it borrows |
| `fix-scan.ts` | the strings a `fix:` can evaluate to: under a key, at a factory's argument, at a class constructor's |
| `fix-imports.ts` | which of those factories a file can call that it did not declare — one relative specifier, one file read |
| `error-contract.ts` | the rules, the two checks that turn them into findings, and `collectDeclaredCodes` |
| `fix-command.ts` | resolving an `x <command>` a `fix:` cites against the registry |
| `fix-path.ts` | resolving a PATH or a glob a `fix:` cites against the root the gate is running in |
| `source-files.ts` | which files are shipped source — shared with `filesize`, never a second list |

**A `fix:` may not cite a command this build does not ship.** Six shipped fix lines named
`x db status`, `x logs tail`, `x trace`, `x metrics`, `x auth whoami` and `x ai prompts`, and every
one passed — the text rule checks that a fix NAMES a command, never that the registry holds it.
`fix-command.ts` resolves the citation, and a PLANNED command fails too: `x logs` parses, `x help`
lists it, and running it hands the reader `X_NOT_IMPLEMENTED` instead of the fix.

**A `fix:` may not cite a file this repo does not have, either.** That was the other half, and
nothing resolved it: `X_UI_RUNTIME_MISSING` told its reader to paste a line no generator ever wrote,
through every gate since it shipped (#274, #246). A file token is one of the four things that make a
fix an instruction at all (`COMMAND_TOKENS`), so `fix-path.ts` is built from the SAME extension list
— a token that satisfies the instruction rule is exactly the token this one has to resolve, and two
lists would be a citation the second rule cannot see. `X_ERROR_FIX_PATH_MISSING` is its own code:
`X_ERROR_FIX_INVALID` means the fix is not an instruction, this one means it is one and points at
nothing, and the repairs differ.

It is narrow so a finding never has to be argued with — three shapes are not judged at all, because
each resolves against something other than the root the gate is running in: a scoped specifier
(`@ultimat3/ui/global.scss`, which resolves through `node_modules`), a dot-relative path
(`./global.scss`, which resolves against the reader's own file) and any path whose **parent
directory** this root does not have (`src/errors.ts`, `apps/web/server.ts`,
`packages/i18n/catalogs/en.json` — all three name a directory a generated app has and this repo does
not). What is left is the citation a root really can answer: a directory that exists, named as
holding a file it does not hold. A glob must match at least one file. Measured over all three roots
the gate runs in — the framework, `examples/dummy`, `dummy/social-media-clone` — **117 path citations
read, 0 findings**, so it enforces outright with no pin table.

The rule is **conditional, and that is load-bearing**: *if* a fix cites `x <command>`, it must
resolve. It does not require every fix to name one — `set OTEL_EXPORTER_OTLP_ENDPOINT=…` and
`counter('orders_total', { maxSeries: 4000 })` are executable and correctly cite nothing, and a
universal rule would push an author into citing a command that does not really fix it. A second
word is judged as a subcommand only when the spec declares subcommands, or `x new my-app` reports
`my-app` as one. The registry arrives through `await import('./registry')` — `registry → cmd-verify
→ error-contract` closes a cycle back to the caller, and the precedent for the break is
`cmd-build.ts`.

**It reads a THIRD word, under the same condition.** `x db branch ls --json` resolved — `db` is a
command, `branch` is one of its subcommands — and the word that decided what actually ran was never
looked at, so a fix line that created a stray database passed every check the repo had. A third
word is judged only where the subcommand declares a closed set (`CommandSpec.subcommandPositionals`,
declared from the constant the command validates against), because `x jobs show <id>` and
`x db gen "add publish_at"` take open positionals and a universal rule would report findings about
working invocations. `positionalChoices` cannot express it: `fix-command.ts` reads that field only
where a command declares no subcommands at all.

**A command with no subcommands must still declare `positionalChoices`, or its second word is unjudged.** `x g migration` shipped in two `@ultimat3/admin` fix lines — a generator that has never existed, answered with `X_CLI_UNKNOWN_COMMAND` when run — because the `g` spec declared none and `fix-command.ts` returns `undefined` for an absent set. The third instance of this class (#131, then `x db branch <name>`). `cmd-generate.ts` now declares `positionalChoices: GENERATORS`, from the SAME constant `readKind` validates against, exactly as `cmd-test.ts` declares `TEST_TYPES` — `fix-command.test.ts` pins `x g migration` as a finding against the real catalog. A new command whose first positional is a closed set and does not declare it is a hole this rule cannot see.

**And in that one slot, a `<placeholder>` is a finding too.** `x db branch <name>` is what two
`@ultimat3/mcp` fix lines said; the citation reader does not read `<name>` as a word, so the slot
was never examined and the line resolved clean while running it answers `X_CLI_UNKNOWN_COMMAND` —
the same blind spot in a second disguise. A closed set means the slot is a verb, so there is
nothing a reader could substitute that would make it run. `CITATION` therefore matches a
placeholder in the third slot **only**: `x jobs show <id>` and `x db branch drop <name>` are correct
fix lines and must stay invisible to this rule.

`collectDeclaredCodes` is the only answer to "which codes exist, and where is each declared?" — one
walk, one entry per code, the owning registry preferred over any throw site and over a registry
that named the code in its `<PKG>_BORROWED_ERROR_CODES`. The docs check reads it and so does the
framework's own `framework.manifest.json`, because a second scanner over a narrower file set is a
manifest that claims completeness it does not have.

An empty `fix`, or a `fix` that says `check` / `make sure` / `try` / `see the docs` and names no
command, call or file path, is `X_ERROR_FIX_INVALID`. A declared code the host's error reference
does not name is `X_ERROR_CODE_UNDOCUMENTED` — `wiki/Error-Codes.md` here, nothing in a generated
app, which is why that half arrives as a host check (`scripts/verify.ts`) rather than a hardcoded
path in this package.

`ts-scan.ts` masks comments and string contents before it looks for structure. The contract's own
3-line rendering appears verbatim in doc blocks and interpolated messages, and a scanner that read
those as declarations would report findings nobody can fix. What it cannot see is a `fix` with no
literal — a parameter, or a table lookup with no fallback. Those are out of a static scan's reach,
and the step says so rather than guessing.

**A fix does not always arrive under a key**, and until `As of 2026-08` the scanner assumed it did.
`@ultimat3/mcp`'s `readonly-sql.ts` hands every fix positionally to a local `rejected(cause, fix)`
helper, so the file held no `fix:` at all and `scanFixes` returned `[]` for all of it — the
citation resolver was never given a string to judge, and two stale `x db branch <name>` lines
shipped through the hole. `scanFixes` now also reads the argument in the `fix: string` position of
a **local** helper, under four rules, each with its own case in `fix-scan.test.ts`: the helper must
BUILD an error (`code` key or `new …Error(` in its body), or `citedCommandProblem(fix, catalog)` —
which takes a fix to *judge* it — would have its call sites read as declarations; the parameter
list may hold no rest or destructured parameter, because neither has a reliable position; the call
may not be a member access; and the argument must BE one literal, stricter than the key path,
because `prefix + 'x doctor'` reads as one literal there and publishing half a fix is worse than
publishing none. Measured over the whole tree: 16 files gained readable fixes, `readonly-sql.ts`
went from 0 to 7, and **zero** new findings.

**And a fix does not always arrive in the file that declares its builder**, which is where four
bad `fix:` lines in `packages/ui/src/icons/build-icons.ts` shipped: `invalidIconDataError` is
declared in `packages/ui/src/errors.ts`, and a per-package `errors.ts` full of factories is the
house pattern, so the same-file rule left the most common shape of all unchecked. `fix-imports.ts`
resolves it — the specifier is relative, the candidate paths are `<base>.ts{,x}` and
`<base>/index.ts{,x}`, and the parameter position is the callee's. An alias is renamed to what the
CALLER writes; a local declaration of the same name wins, because that is the function the call
actually reaches. One module cache per run: `errors.ts` is imported by every file in its package.

**An error CLASS is the same helper one keyword away**, and is now read too: the name is the
class's, the parameter list its `constructor`'s, `new X(…)` is a call like any other. It was
measured as dead code in the same-file rule — zero same-file call sites — and cross-file it is
`@ultimat3/render`'s fourteen classes plus `@ultimat3/core`'s three image ones.

Measured over the whole tree, `As of 2026-08`: **791 → 877** fix literals read, 37 files gained
one, and **3 findings** the gate had never been able to see — `x verify --contract` and
`x build --route` (two flags no command declares) and one `check …` line with no command token.

What it still cannot see is a builder imported from another **package**: `candidatePaths` refuses a
non-relative specifier, because resolving one means guessing which of 29 packages a bare name came
from and a wrong guess reads an unrelated function's argument as a fix. Measured: 3 call sites in
this repo, none of them a finding. It is **not** left silent — the step's `output` carries
`checked {n} fix line(s), could not read {m}`, counted at `FixScan.unreadable`: an argument in a
KNOWN fix position that is not one literal. Deliberately not "imports I could not open", which is
1504 names here and 1310 of them are `join` and `UltimateError` — a number nobody can act on.

`cli → admin` is a declared sideways edge (`scripts/lib/tiers.ts`): `x dev` **mounts** the
dashboard, it never grows a second one. The CLI's only contribution is the facts no registry
holds — a SQL runner, the caught outbox, the committed manifest, the process's own services, the
spans it recorded — supplied as `defaultDevSources({ hooks })`.

Wired means answerable: all eleven panels answer in a `x dev` process, and a hook the CLI does
not supply is a panel that refuses with a wiring line, never one that renders empty. `timeline`
is core's tracer (`x dev` is what calls `configureTelemetry`), `cache` is
`recentInvalidations()`, `policy` is `@ultimat3/policy`'s own `policyMatrix()` over the app's
roles — a verdict re-derived here would be the second authz the framework exists to prevent.
`subscribers` is the one source left unwired: `@ultimat3/realtime` retains no matcher trace, and
that trace is the live panel's question, so the panel degrades to its own note instead.

`dev-traces.ts` reads a span's panel kind off its **name prefix** — a subsystem that starts emitting
spans adds its prefix to `KIND_BY_PREFIX` or its work is filed under `action`. `db.` is there
because `@ultimat3/db`'s two funnels open one span per statement (`db.select`, `db.begin`), and a
statement is the one span that states its own identity — `STATEMENT_ATTRIBUTE`, **imported** from
`@ultimat3/db` by both `dev-traces.ts` and its test rather than spelled as a literal, which the
recorder prefers over the name, so the timeline's `repeatedSql` groups SQL texts and not span names. Those spans
exist only where a `StatementObserver` is installed, so a trace with no DB children is a process
with no statement diagnostic, not a broken recorder.

`dev-n-plus-one.ts` is that observer, and `cmd-dev.ts` is the **only** place that installs it —
`serve.ts` installs neither it nor the in-process trace RECORDER (`createTraceRecorder`, which is
`/_x/timeline`'s source), the same line that file already draws for `/_x`. **It is not "no
exporter"**, `As of 2026-08`: `serve.ts` calls `startOtlpExport(options.env)`, because a collector
named in the chart has to receive spans from the container and not only from a laptop. What a
production process does without is the *statement* diagnostic and the in-memory timeline — the
ledger and the recorder go in together and come out together in `stop()`, because the timeline's
SQL rows and the repeat counts are one feature with one toggle, and uninstalled the seam costs the
one `undefined` branch it already pays (axiom 6).

Three rules hold the ledger, each load-bearing. **Per request, keyed by the `Ctx` object** — a
`WeakMap` whose entry dies with the request, so nothing sweeps and nothing accumulates across a dev
session; a statement issued outside a request is not counted at all, because "five of one shape"
only means something inside one unit of work. The price of keying on identity is that a
`withChildContext` scope is its own tally. **A shape is `entity.op` when attributed**, the
statement's own text with whitespace collapsed when it is not — `members.findById` fifty times is
what an author can act on, and grouping fifty point lookups by their SQL would report bind values.
That rule is **not written here**: `statementFingerprint`/`statementKind` are `@ultimat3/db`'s and
the threshold is `@ultimat3/entity`'s `N_PLUS_ONE_THRESHOLD`, because `@ultimat3/testing`'s
`statements` fixture is a second detector and a copy of either would let a loop that fails a test be
a different loop from the one this ledger warns about. What stays here is what only a dev *server*
knows: the request as the unit of work, the bound report list, one log line per request per code.
**An expected statement is not counted** — `expectedQueryLoop` suppresses a verdict and this ledger
is the verdict, so the span and the timeline still show the loop while the thing that warns is told
the author already answered. A shape is promoted to a verdict exactly once, on the statement that
crosses the threshold, and its count keeps rising: a loop of fifty is one report reading fifty. The
report list is bounded and drops its oldest.

`statement-loop.ts` is the **one** projection those verdicts reach four surfaces through, and the
reason there is only one is that four renderings of one loop must be one sentence. It hands a
verdict to `@ultimat3/entity`'s `nPlusOne()` — the `fix:` speaks that package's vocabulary and is
derived from the relations the schema already declared — and each surface takes a field of what
comes back: `cmd-dev.ts` appends `loopFinding` to the `findings` getter (text and `--json` render it
for free), `dev-dashboard.ts` supplies `statementLoops` so `/_x/timeline` shows `nPlusOne` for the
request on screen, `cmd-dev.ts` again passes `devNotices` down `startRoles` so the browser overlay
renders the loop under the error, and the ledger itself emits `warnLoop` — one `logger.warn` per
request per code, the ids riding along from core's `setLoggerContextFields`.

Two rules about *when* a count is read. **A surface reads it live**: the finding, the panel row and
the notice all say `ran 50 times` because they ask after the loop finished, while the log line says
`ran 5 times` because it was written the moment the threshold was crossed — same verdict, two
honest moments. **A verdict belongs to its request**: `repeatsFor(ctx)` reads the request's own
tally rather than filtering the bounded global list, so the overlay still names a loop the bound
already dropped. `serve.ts` supplies no `devNotices`, so the seam it boots through is a key that is
absent, not a hook answering an empty list.

`dev-n-plus-one.test.ts` and `statement-loop.test.ts` drive the ledger and the projection with
hand-built `StatementEvent`s — fast, and enough to pin every rule above. `n-plus-one-detector.test.ts`
proves the loop those events stand in for: real `posts`/`authors` entities, `postgresRepo` and
`createPgliteClient` (an injected fake driver so no `@electric-sql/pglite` build is needed, but a
real client — `createRecordingClient` implements `DbClient` on its own and never reaches the
observer, so it cannot stand in here) — a naive per-row `findById` loop trips `X_N_PLUS_ONE_QUERY`
with the exact `preload('author')` line, the `preload()` form of the same read stays quiet,
`expectedQueryLoop` silences the naive form without stopping it from running, and a naive per-row
`delete` loop trips `X_N_PLUS_ONE_WRITE`. Its describe block spells the pattern `n1`, matching
`packages/entity/src/n-plus-one.test.ts`'s own fixture prefix, because `bun test -t 'n+1'` is a
regex and `+` is a quantifier — `n1` is what actually selects these tests.

## One migration engine, four environments

| File | Job |
|---|---|
| `migrations.ts` | the app's `packages/db/migrations` read into `@ultimat3/db`'s `Migration` shape — the **one** reader |
| `db-generate.ts` | `x db gen`: entities diffed against what the migrations declare, written as `.sql` + `.snapshot.json` + `.hash` |
| `cmd-db.ts` | the subcommands, and nothing else — `gen` calls `db-generate.ts`, `migrate`/`reset` call `serve.ts`'s `runMigrations` |
| `db-branch.ts` | what a branch IS: the closed verb set, the name it takes on disk and in `pg_database`, and list/create/drop per mode |
| `cmd-db-branch.ts` | `x db branch`'s wiring alone — which verb, which refusal, and the one connection an external clone runs on |
| `db-finding.ts` | one thrown value → one `Finding`, shared by `cmd-db.ts` and `cmd-db-branch.ts` |
| `drift.ts` | `checkSourceDrift`: the `.hash` sidecar `x verify`'s `drift` step compares, no database needed |
| `db-destructive.ts` | `checkDestructiveMigrations`: the same step's second half — every committed `up` that drops, truncates or retypes must carry `-- destructive: true` |
| `db-backfill.ts` | `x db backfill --list`: the flag parsing, the ledger read and the table |
| `db-seed.ts` | `x db seed`, everything except the argv: `SEED_GLOBS` (where a seed is declared), `discoverSeeds`, `parseSeedTierFlag`, `selectSeeds` (which seeds this invocation runs, and its two refusals — `X_DECLARATION_UNKNOWN` and `X_SEED_ENVIRONMENT`), `runSeeds` (one transaction **per seed**, never one around the run) and the two renderers. The `db-backfill.ts` split repeated: a driver plus plain strings in, plain rows out, so every rule is testable with no `ParsedArgs` and no boot. Which tiers an environment takes is `@ultimat3/entity`'s `seedTiersFor` — two copies of "may this seed run" would be two answers |

`jobs-driver.ts` is the ONE place a CLI command gets hold of the app's queue — `withJobDriver`,
which `x jobs` and `x db backfill` both call. It reuses an ambient `jobDriver()` when a process
already installed one (inside `x dev` or `x mcp serve`, booting a second queue talks to the wrong
database) and otherwise boots `startQueue` and releases it in a `finally`, or a CLI that exits
holding the PGlite lock breaks the next command run against this app. A second copy of that boot
would be two answers to "which queue is this command talking to".

**`x db branch` takes a VERB, and a branch name can never be one.** `ls`, `create <name>`,
`drop <name>` — a closed set, declared once in `BRANCH_SUBCOMMANDS` and read three ways: the
command validates against it, `dbCommand.spec.subcommandPositionals` declares it so the `errors`
step can resolve a citation against it, and the refusal for an unknown word lists it. The bare-name
form it replaces is why: the argument *was* the name, so `x db branch ls --json` — the `fix:` on
the planned `x branch`, on `X_DB_BRANCH_FAILED`, and (as `create`/`drop`) on `@ultimat3/db`'s own
`X_BRANCH_EXISTS` and `X_SQL_UNSAFE` — cloned a database called `ls` and returned no listing. All
four passed every check the repo had, because `fix-command.ts` resolved two words and the third was
the one that decided what ran.

**`drop` has no confirmation flag, and that is the design.** It may only drop what `ls` shows: an
external branch is a database carrying the marker comment `createBranch` writes **and** this
database's own `<source>_branch_` prefix, an embedded one is a `pgdata-<name>` directory, so the
shared database this session is connected to is in neither set.
The typo is impossible rather than the keystroke tedious — and `@ultimat3/db` already ships
`x db branch drop <name>` as `X_BRANCH_EXISTS`'s `fix:` with no flag on it, so a flag here would
break a shipped instruction.

**The prefix half is not decoration, and it is no longer the only source guard.** The marker records
the base `As of 2026-08-19` — `ultimate:branch:<base>:<iso>`, read back as `BranchInfo.base` — so
`reapBranches` can skip another app's clones on its own. The prefix guard still stands and is what
`ls`/`drop` read, because an **older** marker records no base at all: it is skipped by the reaper
rather than dropped, which leaves `drop` needing an answer that does not depend on a field half the
branches lack. One Postgres server hosting two Ultimate apps answers `listBranches()` with both
apps' clones, and `branchNameOf` reduced `postly_branch_feat` and `analytics_branch_feat` to the
same branch name — so `x db branch drop feat`, run against `postly`, was authorised by
`analytics`'s row and then issued `drop database if exists "postly_branch_feat"` against a database
carrying no marker at all: a `DROP DATABASE` the guard had never approved, and nothing recoverable
about it. `branchNameIn(source, database)` is the source-scoped inverse of `branchDatabaseName` and
the one `ls` and `drop` both read; `branchNameOf` survives for `mcp-db-target.ts` alone, which has
a URL and no connection to ask `current_database()` with.

**The membership check lives inside `dropExternalBranch`, not in the wiring above it.** One
connection, one listing, one statement before the `DROP` — a listing taken by the caller and acted
on afterwards is two connections and a window wide enough to hold a whole `create`. It is still not
atomic and cannot be: `DROP DATABASE` runs in no transaction, so no single statement both verifies
the marker and deletes. Closing the last gap means a lock around both halves inside
`@ultimat3/db`'s `dropBranch` — which a `psql` at the next terminal would not hold either.

**`ls` is the reason `create` no longer shells out to `psql`.** `listBranches()` finds branches by
`createBranch`'s marker comment; the `psql` path wrote the `CREATE DATABASE` and no comment, so
every branch the CLI made was invisible to the only lister the framework has. External branching
now runs through `@ultimat3/db` on one `role: 'migrate'` client — `max: 1`, no statement timeout,
both load-bearing: `CREATE DATABASE … TEMPLATE` is refused while any *other* session holds the
template, and cloning a real database outlives a `web` profile's 10s.

**`DatabaseTarget.production` is a fact this package supplies, and it was the literal `false`.**
`mcp-db-target.ts` is the only place one is ever built, so `assertBranchDatabase`'s first refusal —
"production is never migratable from MCP at all" — could not run for any database the CLI produced;
a production database was refused only incidentally, because its name lacked `_branch_`, and one
named `shop_branch_hotfix` read as a branch and was migratable. It is now core's one key, read the
way `x doctor` reads it. An **unreadable** `ULTIMATE_ENV` counts as production: `tryResolveEnvironment`
answers `undefined` for exactly one input — a value that is not an environment — and a guard that
read a typo as "not production" would be defeated by the misconfiguration it exists to survive.
`staging` stays false; `branch: null` is already what refuses it, and widening the flag would make
the refusal say something untrue.

`x db backfill` has four shapes and a **dry run is the default**: `--list` reports the ledger,
`--pending` reports declared-minus-completed and exits non-zero when there is drift, `<name>` plans
one sweep, and `--all` plans every pending one. `--write` is never implied — the inspection forms
and the acting form are the same command, and the flag is the only thing that separates them.
`--all --write` isolates per name and continues past a failure, exiting non-zero naming each, so one
wedged cleanup cannot block every later one forever.

Until 1.2.0 a bare `x db backfill <name>` threw `X_NOT_IMPLEMENTED`, and the ledger was the only
half that existed: `x_backfills` recorded what had run, and **nothing recorded what was pending**, so
a scaffolded backfill could be merged and deployed and silently never run. `--pending` is the alarm
that closes it; `registeredBackfills()` is what makes a declaration visible before its first pass.

`x db migrate` and `ROLE=migrate` are the same function call. That is the whole design: until
1.2.0 the CLI shelled out to `bunx drizzle-kit` — a second engine, a second journal, declared in no
`package.json` and fetched unpinned at run time — while the release phase used the framework's
ledger, so "what has been applied" had two answers that only agreed by luck. `cmd-db.test.ts`
holds the line from both ends: no shipped source spawns a second migrator, and this file still
imports `runMigrations` from `./serve`.

**The post-condition is one check too, and it is the database one.** `runMigrations` runs
`@ultimat3/db`'s `checkDrift()` inside the queue's lifetime — the connection it opened for the
migrator is the only one there is — and returns the report on `MigratedApp.drift`, so a developer
and a release phase verify the same thing. `x db migrate` renders it through `driftFindings` and
exits non-zero; `runRole` throws the first difference for `ROLE=migrate`, so the release phase
exits non-zero too. Both entrypoints call the same `runMigrations` and both fail — the difference
is only the channel each has. `ROLE=migrate` logged and exited 0 until it did not: a release phase
whose only signal is the exit code reported success over a schema nobody can reconstruct, which is
the failure the post-migrate check exists to catch.

**The `drift` step asks a third thing, off the same directory and with no database either: is every
destructive statement declared?** `db-destructive.ts` reads each committed migration through
`migrations.ts` — the reader `x db migrate` applies from, because a rail checking a list the
migrator does not run enforces nothing — and refuses an `up` that drops a table, drops a column,
truncates or retypes without a `-- destructive: true` line, as `X_MIGRATION_DESTRUCTIVE`. It decides
none of that itself: `@ultimat3/db`'s `destructive.ts` owns the classifier `db-generate.ts` already
wrote the marker from, so the generator and the gate cannot disagree about one file. One finding per
file, never one per statement — the marker declares the whole migration. It rides on `drift` rather
than becoming an eighteenth step because it is this step's own question over this step's own files;
a new step is for a genuinely new question.

The *source* half is a different question with a different answer: `checkSourceDrift` hashes the
entity source against what `x db gen` recorded, answers the same before and after a migration, and
opens nothing — which is what lets the gate run it in a CI with no database. It stays on `x verify`
and `x doctor` and is deliberately **not** repeated on `x db migrate`; two reporters of one
condition is the duplication this package's own rule forbids. Both were called `checkDrift` until
1.2.0, and the one that was wired everywhere was the one that cannot see a column added by hand.

Generation opens no database. It diffs `describeEntities()` against `declaredSchema(readMigrations(root))`
— the snapshot the newest migration wrote down — so `x db gen` answers the same in CI, on a laptop
with nothing running, and against a database three migrations behind. An app whose modules will not
load generates **nothing**: a short registry is indistinguishable from deleted entities, and the
diff would be a DROP nobody asked for.

**An empty diff re-records the `.hash` sidecar, and that is what makes `X_DB_DRIFT` followable.**
The hash `checkSourceDrift` compares covers every non-test file under `packages/db/src` — a seed, a
helper, a decorator — not only the ones that imply DDL, and narrowing that glob would trade a loud
error for a silent gap in the one check that catches "entities changed and no migration was
generated". So detection stays broad and the REMEDY carries the weight: `x db gen "describe the
change"` — the exact `fix:` the error hands out — records the current hash against the newest
migration when the diff is empty, instead of writing nothing and leaving the gate red forever with
hand-editing a generated file as the only way out. `GeneratedFiles.outcome` is the four things a run
can be — `generated`, `hash-recorded`, `unchanged`, `blocked` — and `runGen` projects it onto
`--json` on **every** branch: reporting `hash-recorded` as `generated` would name a migration nobody
can apply, and reporting it as `unchanged` would hide a file this command wrote. That second one
shipped: the no-migration branch hardcoded `data: { migration: null, files: [] }`, so the run that
wrote the sidecar reported writing nothing to the machine reading the output.

Nothing is masked, and the branch proves it rather than promising it: `loadApp` reported no findings
(the registry is whole, never short), `declaredSchema` returned a real snapshot (`X_MIGRATION_SNAPSHOT_MISSING`
otherwise), and the emptiness is `generateMigration`'s own verdict — the same call the written path
takes. A migration with no migration id to record against writes nothing, which is the
`x new --no-example` case: an entity against zero migrations is `create table` for all of it and
never an empty diff. `reconcileSchemaHash` also declines to write when an OLDER migration already
recorded the hash, because `checkSourceDrift` already answers clean there and restamping the newest
sidecar would claim it produced a schema it did not — one predicate, `isRecorded`, read by both.

One migration is one file, split by a lone `-- down` line. `<id>.down.sql` is a pre-1.2.0
hand-written layout and `readMigrations` skips it — read as a migration it sorts next to its own
`up` and drops every table the pair exists to reverse.

## `x dev` boots the app; it does not simulate one

| File | Job |
|---|---|
| `api-routes.ts` | the app's API over HTTP: every registered action AND every registered query |
| `dev-services.ts` | resolve which service each binding points at — embedded or external |
| `dev-queue.ts` | the db + queue pair alone, and the one place that takes every ambient accessor back |
| `dev-runtime.ts` | start the rest on top of it and install the remaining accessors (storage, mail, transport) |
| `dev-cache.ts` | which cache tiers this process reads through, and the cross-instance invalidation hop |
| `dev-purge.ts` | the hourly retention sweep: which framework tables this boot owns, the `purge()` job over them and the `task` that fires it |
| `dev-sync.ts` | the `sync` role: its live-query registry, who is dialling it, and the socket it owns |
| `runtime-overrides.ts` | the one field a host hands the framework a driver through |
| `sync-authenticator.ts` | the app's HTTP authenticator, seen as the sync node's |
| `otlp-export.ts` | the exporters `OTEL_EXPORTER_OTLP_ENDPOINT` switches on, and their drain hooks |
| `dev-render.ts` | one HTTP route per registered `route`, through render's own mode function |
| `style-csp.ts` | the `style-src` sha256 of every inline `<style>` the web role serves |
| `dev-assets.ts` | the image pipeline's only HTTP surface: `/icons/*` and `/media/*` |
| `favicon.ts` | `/favicon.ico`: the app's own file, and the bytes the framework answers with when there is none |
| `dev-hooks.ts` | the pipeline's `authorize` seam, decided from the app's own `Policy` objects |
| `dev-roles.ts` | `--role` selection plus start/stop for `web`, `sync`, `worker`, `scheduler` |
| `dev-dashboard.ts` | the `DevSources` hooks only this process can answer, and the two CLI panels |
| `dev-traces.ts` | core's spans → the `/_x` timeline's request traces |
| `dev-n-plus-one.ts` | statement shapes counted per request, and the ones that repeat past the threshold |
| `statement-loop.ts` | one verdict → the finding, the panel fact, the overlay notice and the log line |
| `dev-policy.ts` | which actors to ask about, and which capability each policy gates |
| `cmd-dev.ts` | boot order, mounting `/_x`, installing the span exporter, the file watcher |
| `mcp-host.ts` | the `DevCapabilities` half of `@ultimat3/mcp`'s `DevHost` — db, tests, logs, verify |
| `mcp-db-target.ts` | which database the host is pointed at: whether it is a branch, and whether it is production |
| `mcp-errors.ts` | `errors.explain`: one runnable command per code, typed over `CliErrorCode` |
| `error-catalog.ts` | imports every `@ultimat3/*` package so `x errors` answers for codes no command loads |
| `mcp-test-output.ts` | reading `bun test`'s own summary back into a `TestRun` |
| `cmd-mcp.ts` | `x mcp serve`: the two transports, and the local developer's caller |

`api-routes.ts` is the app's own API surface, composed **once** and mounted by both `cmd-dev.ts`
and `serve.ts`: `listActions().map(toRoute)` from `@ultimat3/action` plus
`listQueries().map(toQueryRoute)` from `@ultimat3/query`. Two lists is how `query.client()`
shipped deriving `/_x/query/<kebab>` against a route neither file mounted — a typed read that
compiled everywhere and 404'd everywhere — and a surface that answers in `x dev` and not in the
container is the same failure one release later. It reads the registries at call time, never at
import: importing the app IS the registration, and it happens after this module loads.

`startWeb` warns when the route table declares `auth: 'required'` and the app configured no
authenticator: `hooks.authenticate` is the only place an actor can come from, so such a process
boots clean, reports healthy, and refuses every valid session. A warning and not a throw, because
`x new` scaffolds guarded routes before it scaffolds an authenticator.

The roles live in `@ultimat3/core` (`ROLES`, `isRole`), never in a second list here. A dev-only
driver, a dev-only authorizer or a dev-only queue is the bug this design exists to prevent — the
only thing dev changes is which driver is behind an interface.

### `RuntimeOverrides` is the only way to hand the framework a driver

`ServeOptions` was `{ root, env, role?, port?, metricsPort? }`, so the ONLY way an app could
install a driver was an ambient setter at module scope — and `loadApp` imports the app's modules
*after* `startServices` has captured its own. The slot moved and the capture did not: every
`handle.enqueue()` went to the app's queue while the worker claimed from Postgres, and `/_x` read
the ambient one, so the dashboard agreed with the enqueue side and disagreed with reality.

Every field REPLACES the env-selected default rather than sitting beside it — `overrides?.x ?? <the
env switch>`, one expression, one answer (axiom 1). A field nothing consumes is not there: the
entity `Driver` in particular, because `@ultimat3/entity` exposes no installer for one
(`database(entities, { driver })` is the app's own call), and a slot the boot cannot honour is the
class of defect this seam exists to end.

**The split is refused, not reconciled.** `assertOneJobDriver` runs first in `startRoles` and
throws `X_RUNTIME_DRIVER_SPLIT` when `jobDriver()` is not the object this process serves. Reading
through the accessor instead would make the split invisible rather than impossible — and the app
would still have installed a driver the boot never saw, with no outbox store bound to it and no
relay draining it.

### What the boot now calls that nothing called before

| Mechanism | Where | Was |
|---|---|---|
| the transactional outbox | `dev-queue.ts` installs the store + facade, `worker` runs the relay | staged rows nothing published |
| the durable scheduler | `pgSchedulerState` + `createPgLeaseLeader` in `startRoles` | a watermark forgotten on restart, and every replica its own leader |
| the Postgres event bus | `dev-queue.ts` | `step.waitForEvent` forgot every correlation on restart |
| the shared idempotency store | `dev-queue.ts` | a retry on another replica charged the card twice |
| the shared auth limiter | `configureAuthLimiters` in `startServices` | account lockouts counted per POD, so N replicas granted `maxAttempts × N` guesses |
| the retention sweep | `dev-purge.ts`, declared in `startServices` | three `purgeExpired()` with no caller — every row `x_idempotency`, `x_rate_limit` and `x_auth_*` ever took was kept |
| the cache tiers | `dev-cache.ts` | only the CDN tier was registered; memo, LRU and Redis had zero callers |
| WebSocket authentication | `dev-sync.ts` | `actorId: null` on every socket — realtime was single-tenant by wiring |
| OTLP export | `otlp-export.ts` | the chart set the variable and no code read it |

`createPgLeaseLeader`, never `createPgLeader`: the latter's `pg_try_advisory_lock` is
session-scoped and the grant dies when the connection returns to the pool, so every node reads
itself as leader and a rolling update double-fires every task.

The relay runs on `worker` and only `worker` — the role that exists wherever jobs run at all.
Duplicating it is safe — the claim is a **lease** taken in the statement that locks the row
(`@ultimat3/jobs`' `outbox-pg.ts`, fenced on `claimed_by`), so two relays never hold one batch —
but pointless. The idempotency key is not the reason and never was: its conflict target is a
partial index over live states, so it collapses a repeat only while the first job is still live.

`SQL_IDEMPOTENCY_TABLE` is applied beside `SQL_JOBS_TABLE`, and the store is installed by the boot
rather than by the app, even though `@ultimat3/action` documents
`postgresIdempotencyStore({ executor: Bun.sql })`: **`Bun.sql` has no `.query(text, values)`** — it
is a tagged template whose positional form is `unsafe` — so that line does not satisfy `PgExecutor`,
and a second executor would open a second pool against a URL this boot already resolved. The app
owes only the declaration, `configureIdempotency({ scope: 'shared' })`, which `x new` names in
`apps/web/server.ts`.

The per-TENANT subscription cap is deliberately unset, and **both halves of it are**:
`assertCapacity` returns early unless `maxPerTenant` AND `tenantOf` are given, so passing one arms
nothing — and no default is defensible when one tenant is a person and the next is five thousand
seats. The per-socket 128 stands because a socket is one browser tab.

`trustProxy` is read from `TRUSTED_PROXY_HOPS` in `startWeb`, the way `PORT` and `ROLE` are read: it
is a fact about the deployment, not an app config choice, and one image runs behind an ingress in
one cluster and behind nothing on a laptop. Without it `ctx.ip` is the ingress's socket address on
every request, so the limiter keys the whole fleet's anonymous traffic into one bucket.

### `island-bundle.ts` is the bundler half of `hydrate`

`@ultimat3/render` shipped `island()`, the collector, `emitIslandAttributes`, `hydrateRuntime`,
`RouteEntry.islands` and `routeJsBytes` — and **nothing constructed or populated any of them**.
`hydrate` was a documented capability with no implementation, to the point that `render-static.ts`
told authors to "move the request-dependent part into an island", naming a mechanism the framework
could not express. This package is the half that can see a file on disk, so it is the half that was
missing.

| File | Job |
|---|---|
| `island-bundle.ts` | discover `*.island.tsx`, build each as its own entry point, hash it, resolve a page's specifier to its URL |
| `island-routes.ts` | serve those chunks, at `ISLAND_BASE_PATH`, immutable |
| `dev-render.ts` | one collector **per render**, and `hydrateRuntime` after the body |
| `prerender.ts` | build first, write the chunks into the export, then measure |
| `budgets.ts` | `measureDocumentJs` weighs `data-x-entry` as well as `<script src>` |

**One `Bun.build` per island, never one call with N entry points**, and `splitting: false`. The
island's `src` is a string, so no import edge reaches it and the page's graph stays the page's
(axiom 6) — a shared chunk would put that number back behind a graph walk, and the budget compares
against bytes. Two islands that both import the same helper each carry a copy; that is the honest
number for what booting either one costs.

**The chunk URL is content-addressed with render's own `contentHash`** — the function that already
stamps an ETag and a precache revision. One identity for a byte string, not a third.

**`x dev`, the container and the static export all mount the same table.** `serve.ts` builds the
islands at boot for the same reason it mounts `apiRoutes()`: a seam that works in dev and not in the
image is the same failure one release later. `x dev` rebuilds them on the watcher tick, and that is
the one reload that actually takes effect — an island is the single module this process never
imports, so there is no Bun module cache to invalidate.

**`app-load.ts` skips `*.island.tsx` deliberately.** It registers no primitive, and importing it
would put the one module guaranteed to be outside the server's graph inside this process's, where a
top-level `document` reference takes the whole scan down.

**The budget is charged from the emitted document, and it names the island.** An island's chunk is
reached by `import()` from inside the hydration runtime, so it is never a `<script src>` — weighing
script tags alone charged a page for the runtime and never for the code that runtime boots.
`measureDocumentJs` reads `data-x-entry` as what it is, dedupes it (two instances of one island are
one module), and `prerenderSite` maps the heaviest URL back through the bundle so
`X_BUDGET_EXCEEDED` names `apps/web/site/pricing/calculator.island.tsx` and not a hash.

`X_ISLAND_INVALID` is **borrowed** from `@ultimat3/render`, not twinned: "this src cannot become a
client entry" is what that code already means, and the bundler is simply the half that can see
whether the file exists. A failed compile is `X_BUILD_FAILED` — an island is a bundle entry point
like any other, and `Bun.build` *rejects* rather than answering `success: false`, so the catch is
the real path.

### `dev-assets.ts` is where the image pipeline meets HTTP

Three packages declare what an image is and none of them serves one: `@ultimat3/seo` says what a
variant URL means (`parseImageQuery`) and produces the bytes (`builtinImageDriver`),
`@ultimat3/storage` says what a variant is called and where it is cached (`variantKey`), and
`@ultimat3/pwa` says which icons a web manifest promises (`planIcons`, `BuiltinImagePipeline`).
Pixels are `@ultimat3/core`'s pipeline, only ever. This file picks two base paths — `ICON_BASE_PATH`
and `MEDIA_BASE_PATH` — and decides nothing else; a resize, a format table or a second cache key
here is the drift the split exists to prevent.

**`/media` and `/_storage` are one authz decision, not two.** Both serve objects off the app's only
disk, so `/media/*key` declares what `dev-storage.ts` declares — `auth: 'required'` +
`STORAGE_READ_PERMISSION` + `enforcedBy: 'handler'` — and calls the same two functions, in the same
order: `authorizeStorageRead` then `assertReadableKey`. It shipped `auth: 'public'` with no policy
and no tenant check while its twin required both, which made every tenant's uploads one URL away in
production (`serve.ts` mounts it), and `?w=` made it an unauthenticated `put` besides. The tenant
test lives in ONE function both routes call, and `storage-surfaces.test.ts` pins the pair against
each other — every case names the verdict absolutely as well as comparing the two, because equality
alone is satisfied by both surfaces failing open together. Cacheability follows the key, not the
route: a tenant-scoped key takes `AUTHORIZED_OBJECT_CACHE` (`private, max-age=0`, varying on
`authorization`/`cookie`), and only a key no tenant owns keeps `immutable`. A genuinely public image
belongs under `apps/web/site/`, which is a static asset and never touches that disk.

**A variant is CACHED only at a width the framework can mint.** The cache key is built entirely
from caller-supplied query values, so `?w=1`, `?w=2`, … each wrote a new object to the app's only
disk, on a route every signed-in tenant may reach for their own keys. `@ultimat3/seo`'s
`MAX_IMAGE_WIDTH` (8192) bounds that and does not close it. `isMintableWidth` is the bound:
`DEFAULT_WIDTHS` **plus the source's own intrinsic width**, which is exactly the set `usableWidths`
puts in a `srcset` — the constant alone would refuse the widest entry of any image whose intrinsic
width is not one of the eight. Anything outside it is still served; only the `put` is refused, so
no caller gains a new 4xx. `?q=` is deliberately still unbounded here — the closed set for quality
is `@ultimat3/seo`'s to declare, not this file's.

**`/favicon.ico` is a mechanism, not a scaffolded file.** Every browser requests it unprompted, the
scaffold wrote none and neither served surface mounted a route, so a permanent 404 sat in the console
of every app the framework produces — noise that trains the reader to ignore console errors, which is
the opposite of what `--json` and an executable `fix:` are for (#272). Two rungs and one path: the
app's own `apps/web/site/favicon.ico` wins, and `favicon.ts` answers a 32x32 PNG encoded through
`@ultimat3/core`'s own pipeline when there is none — the same encoder `x new`'s icon goes through, so
there is no second image format in the tree and no base64 blob nobody can verify. It is deliberately
NOT derived from `ICON_SOURCE`: resizing the install icon needs `@ultimat3/pwa`'s pipeline and would
make the answer depend on a file that may be absent, which is a third rung under a mechanism that has
exactly two. The file is read per REQUEST, so dropping one into a running `x dev` takes effect
without a restart. It mounts through `assetRoutes`, which is the one route set `serve.ts` and
`cmd-dev.ts` both compose — a favicon added to one of them alone is a 404 that comes back in
production only — and `prerenderSite` writes the same bytes into the static export, because an
artifact served with no process behind it has to carry every byte the browser will ask for.

`ICON_SOURCE` lives here, not in `cmd-doctor.ts`, because this is the module that reads it: the
diagnostic checks what `x dev` serves, so one constant cannot pass the check and serve nothing.
It is a **PNG** — core decodes PNG and JPEG only, and the SVG this used to name could never
become an icon.

The routes mount whether or not the source icon exists, and a missing one is refused with
`X_PWA_ICON_MISSING` and its fix — a route that silently disappears is a 404 whose meaning an agent
has to guess. Deliberately **not** also a boot finding: `x doctor` already reports this condition,
with this code, and two reporters of one condition is the duplication this package's own rule
forbids. `x dev` owns the runtime half; the diagnostic owns the other.

### `hold.ts` is why a long-running command outlives its own result

`dispatch` renders a `CommandResult` and `bin.ts` exits on the code — so a command whose server is
still listening when `run` resolves is a command the exit code takes down, between the line that
announced the url and the first request to it. `x dev` and `x mcp serve --transport http` both did.

The one answer is `CommandResult.hold`: report first, then `dispatch` awaits the hold before the
exit code. `holdUntilShutdown` installs core's signal handlers (`installSignalHandlers` — until
this it had no callers anywhere, which is why `cmd-mcp.ts`'s `onShutdown` registration was never
reached), waits on the **drain's first phase** rather than on a signal list of its own, and
releases what core's lifecycle never learned about — the embedded Postgres, the worker, the
watcher — *after* the drain, so an in-flight request still has the database it opened against.
Ctrl-C is therefore the same three phases production runs, not a kill that leaves `.x/pgdata`
locked by a process that no longer exists.

Commands: `bun test`, `bunx tsc --noEmit -p tsconfig.json`.

## A declared flag with no reader is a promise `x help` makes and nothing keeps

`x deploy --critical` said *"security deploy: forces clients to reload"* and forced nothing: the
value is written into the plan JSON (`cmd-deploy.ts`) and **no package reads that field**. The
parser accepts every declared flag, so this is neither a parse error nor a type error — the flag
worked perfectly and meant nothing, to the operator most likely to be shipping a security patch.

`flag-reads.ts` is the rule that can see the class of defect: **every flag a command declares is
read by something in the CLI's own source**, as `X_CLI_FLAG_UNREAD`. The four global flags are
excluded — `--json`, `--help`, `--cwd` and `--verbose` are the parser's, read once for every
command, and a per-command rule would report all thirty declarations of `--json`. The read test is
deliberately generous: a bare `'name'` literal anywhere outside a `name:`/`short:` spec field
counts, so a flag echoed only into `--json`, or read through a shared constant, is read. A gate
that guessed at intent would report findings about working commands.

It is enforced by `flag-reads.test.ts`, in the `unit` step — the same shape `cmd-planned.test.ts`
and `error-catalog.test.ts` use for a rule about the CLI's own declarations, and the reason its
`fix:` is a `bun test` line rather than an `x` command: the rule can only ever fire in this repo.
Promoting it to `x verify`'s `boundaries` host check is one line in `scripts/verify.ts`.

**It does not catch `--critical`, and that is the honest limit.** The flag IS read —
`flagBool(ctx.args, 'critical')` — and what had no consumer was the plan FIELD, one level below any
rule over names. Two stronger rules were measured and rejected: "the read must not be a property
initializer" reports six flags, five of which work (`x db --allow-destructive`, `x jobs --queue`);
"the summary must match the behaviour" is undecidable. So the flag's summary now says what it does,
and forcing a reload is **not a thing this framework does**, `As of 2026-08`. `updateSignal`
had no runtime caller for four majors and 9.0.0 deleted it rather than wiring it: `pwa` is tier 4
and the two runtimes holding both build ids — `http` (2) and `sync` (3) — are below it, so no
legal import could ever have reached the function. A deploy command has no channel to a running
client regardless; the plan is `docker compose up` or `helm upgrade`. What ships is notification:
`useConnection().updateAvailable` from `@ultimat3/realtime`.

## Planned commands are commands

Every command in `wiki/CLI-Reference.md`'s planned table is in the registry, built from
`PLANNED_COMMANDS` in `cmd-planned.ts`, and exits `X_NOT_IMPLEMENTED` with a `fix:` naming the
closest **shipped** command. `X_CLI_UNKNOWN_COMMAND` would say "you typed something that does not
exist", which is false and sends an agent hunting a typo. `cmd-planned.test.ts` enforces both
halves: every row is reachable through the parser, and no `fix` points at another planned command.

`PLANNED_SUBCOMMANDS` is the same promise one level down, and `x db studio` is its only entry.
A subcommand stays in its command's `subcommands` list — the parser reaches it, `x help db` lists
it — and the owning `run` does `throw plannedSubcommand('db', 'studio')`. Dropping it from the list
instead would answer `X_CLI_UNKNOWN_SUBCOMMAND`, which is the same lie the table above closes.

## `guards/` is how an app makes its own convention a build error

Axiom 3 says a convention that is not a build error does not exist, and until 1.2.0 the framework
gave an app no way to create one: `VERIFY_STEP_NAMES` is a closed literal list with no extension
point. A file in `guards/` closes it.

| File | Job |
|---|---|
| `guards.ts` | what a guard IS, how the directory is read, and what a guard is held to |
| `templates/guard.ts` | `x g guard <name>` — the emitted rule, its pure half and its test |
| `cmd-verify.ts` | one line in the `boundaries` step: `guardFindings(ctx.root)` |

**It rides on `boundaries`, and it is not an eighteenth step.** The `HostCheck` contract already
says the shape — *a host adds findings to a step; it can never add, remove, reorder or skip one* —
so "green" keeps meaning exactly what it meant, whatever an app writes. `boundaries` is the step
whose host slot already carries "rules this repo makes about itself that the framework cannot
know" (the monorepo's tier table arrives through it), and it runs third, before any suite, so a
convention failure comes back in seconds. `guardFindings` is *typed* as a `HostCheck` and is
composed by the step rather than registered as one: the slot is `Partial<Record<VerifyStepName,
HostCheck>>`, one function per step, so an app registering there would evict the framework's own
tier check — and `verifyCommand.run` passes no `hostChecks` at all, which is why an app-supplied
check could not have reached the gate through that field in the first place.

**Discovered, never registered.** `guards/*.ts`, minus `*.test.ts`, sorted. Nothing imports a
guard, nothing lists one, and there is no `defineGuard` to call — a guard that has to announce
itself is a guard an app can forget to announce, which is the coupling axiom 8's extension model
rejects. A `*.test.ts` beside a guard is its test: importing it would run a suite inside the gate.

**A guard returns `Finding[]`, so it inherits everything.** `--json`, the step table, the summary
counts and the exit code are all projections of what it returns (axiom 2); a guard that printed or
chose an exit code would be a second gate. It never throws for a normal result — a throw is
`X_GUARD_FAILED`, reported as a finding rather than taking the run down.

**And what it returns is held to the error contract.** `findingProblem` demands an
`X_SCREAMING_SNAKE` code, a non-empty cause, and a `fix:` that passes `fixProblem` — the *same*
rule `x verify`'s `errors` step applies to every shipped `fix:` in this repo. It runs on the
returned value, which is the half a static scan cannot reach: a `fix` assembled at run time has no
literal to read. Three codes, one per way a guard can fail to be one — `X_GUARD_INVALID` (no
usable export), `X_GUARD_FAILED` (it threw), `X_GUARD_FINDING_INVALID` (what it returned is not a
finding). Anything else about a guard is the app's business: no size ceiling, no budget, no rule
about what it may check.

**The validator may never be the thing that crashes.** `findingProblem` names an offending value
through `shown()` and not `JSON.stringify` — which refuses a BigInt — and every candidate is read
inside a `try`, because reading one can throw on its own (a getter that raises, a proxy that
refuses). A guard returning `[1n]` is `X_GUARD_FINDING_INVALID`, per candidate, so one unreadable
entry costs its own line and not the real findings beside it. The mechanism whose job is producing
structured failures handing back a stack trace is the one outcome it exists to prevent.

**`x new` ships four guards, `As of 2026-08-22`.** The scaffolded `AGENTS.md` states nine
non-negotiables, and five of them used to be prose — each proven green on `x verify`: a hardcoded
JSX string beside a `t()` call, `color: #ff0000` in a stylesheet whose own scaffolded header called
it "a lint failure", `toLocaleDateString('en-US')` with no `timeZone`, `t.number` money, and a bare
`throw new Error` in a repo. Four of the five are now guards the scaffold writes —
`guard-raw-colour`, `guard-unzoned-date`, `guard-bare-error`, `guard-untranslated-string` — so the
rule is a build error the day the app is created rather than a sentence an agent may skip. The
fifth, money-as-float, has **no static signature**; the scaffolded `AGENTS.md` row now points at the
`MoneyInput` type error that already fires, because shipping a guard that cannot work is worse than
naming the mechanism that does. Their codes are app codes derived from the guard name, so none of
them appears in `wiki/Error-Codes.md` or the manifest.

`x g guard <name>` writes `guards/<name>.ts` and its test, and nothing else — no index, no
registry row, no manifest entry. The emitted rule is the class of failure a guard exists for: a
migration that adds a `NOT NULL` column with no `DEFAULT` applies cleanly to an empty local
database and fails on the first production table that already holds rows. The `drift` step reads
those same files and asks a different question, and a test suite runs against a database the
statement has never met — which is exactly when an app needs a rule of its own. Its code is
DERIVED from the guard's name (`guardCode`), never written as a literal: an `X_*` literal in
framework source is a framework code and `error-catalog.test.ts` requires it to be registered.

That rule is held to a real bar, because it is the worked example every app starts from and a
demonstration that is wrong on realistic input teaches the wrong shape. Block comments are
stripped before line comments and both before statements are split, so a commented-out
`ALTER TABLE` is a note and not a finding that blocks `x verify` over nothing; and `DEFAULT NULL`
counts as **no** default, because it is one in syntax and none in effect — every existing row still
takes NULL and still violates `NOT NULL`. Both cases are in the emitted test, which is what proves
an app's copy still works, and both run through the real seam in `guards.test.ts`.

It is in `FIXTURE_GENERATORS` like the other two, and it is the only generated file that imports
`@ultimat3/cli` for its types — so the scaffold gate compiling it is what proves a scaffolded app
can write one at all. The root `tsconfig.json` `x new` scaffolds has no `include`, so `guards/` is
typechecked there by default; an app whose tsconfig names an explicit `include` list has to add
`guards/**/*` to it, or its guards compile nowhere.

## Two generators that scaffold something other than a primitive

`x g island <name> [--at <dir>]` writes a **client entry point**, not a component: the filename is
how the bundler discovers it and `mount` is how the hydration runtime calls it, so the filename,
the `mount` export and that `mount` RENDERS are what `templates/island.test.ts` pins — it builds
the emitted entry with `buildIslands` and drives it with `mountIsland`, so a template that
typechecks and does not mount is a failing test. It runs the mutation too, rather than describing
it: the same island with `{count()}` replaced by `{0}` must fail the assertion the live one passes.
`--at` takes the directory directly rather than deriving one, because the caller that cannot guess
is `X_ISLAND_INVALID` — its cause already holds the exact path a page's `src` resolved to, so its
`fix:` hands that path straight back.

`x g admin:page <name> --permission <perm> [--at <dir>]` writes an ordinary TSX component and **no
`defineRoute` call**, deliberately. `@ultimat3/admin`'s `pages:` is the one thing that puts a page in the route
table and `guardedPage()` is the one thing that decides it; a generator that emitted a route
declaration would hand back the unguarded second way in that seam exists to close. The emitted test
asserts the absence. `--permission` defaults to `<name>:read` rather than to nothing, because an
empty permission list is `X_ADMIN_PAGE_UNGUARDED` at declaration time. `--at` is the same flag
`x g island` takes and for the same reason — an app's admin is wherever its `defineAdmin` is, which
no generator can derive, and the hardcoded `apps/admin/src/pages` sent every other layout (the
demo's is `apps/admin/app/admin`) to `git mv` after every run.

Both are in `FIXTURE_GENERATORS`, so both are compiled by the scaffold gate.

Implementing one means deleting its row and adding a real `cmd-<name>.ts` — the summary's
`(planned)` suffix disappears with it, and `x help` follows automatically.

Adding a command: write `cmd-<name>.ts` exporting a `CliCommand`, register it in `registry.ts`,
add its message keys to `messages.ts`. Help and parsing derive from the spec automatically. A
command's `run` must be `async`: a synchronous throw escapes every caller that awaits the promise
the signature promises, `dispatch`'s own error path included.
