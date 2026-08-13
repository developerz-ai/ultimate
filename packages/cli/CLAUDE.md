# @ultimat3/cli — boundary

Tier 5. May import tiers 0–4. Nothing imports this except `create-ultimate`.

| Rule | Detail |
|---|---|
| Entry | `src/bin.ts` (`#!/usr/bin/env bun`) — argv, stdout, exit code only |
| I/O | only `dispatch.ts` renders or exits; commands return `CommandResult` |
| Staying up | a command still listening when `run` resolves returns `hold` (`hold.ts`), or `bin.ts` exits out from under it |
| `--json` | every command, no exceptions — same data as the human render |
| Errors | codes + titles in `src/error-codes.ts`, classes in `src/errors.ts`, subclass `UltimateError`, never a bare `Error` |
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
| `x jobs` | `cmd-jobs.ts`, `jobs-{report,drain,json,table}.ts` | `@ultimat3/jobs`' own introspection |
| `x tasks` | `cmd-tasks.ts`, `tasks-facts.ts` | `registeredTasks()` + `@ultimat3/time`'s cron resolution |
| `x policy` | `cmd-policy.ts`, `policy-facts.ts` | `@ultimat3/policy`'s `policyMatrix()` over the app's own `Policy` objects |
| `x i18n` | `cmd-i18n.ts`, `i18n-audit.ts` | `@ultimat3/i18n`'s `extractFromFiles` + `auditCatalogs` |

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

**A catalog is authored nested and read flat.** `Catalog` (`{ 'nav.home': 'Home' }`) is the
translator's form; the file on disk holds `{ nav: { home: 'Home' } }`, and `parseNestedCatalog`
refuses a dot inside a key — so anything writing a catalog goes through `nestCatalog`
(`serializeCatalog` for `x i18n add|sync`, `templates/catalog-json.ts` for every generator) or it
emits a file `defineCatalogs` rejects at the app's first boot. `merge: 'json'` unions **deeply**
(`json-merge.ts`) for the same reason: `x new` and `x g resource` both contribute under `app`, and
a shallow spread keeps one of them.

## The `errors` step enforces the error contract

| File | Job |
|---|---|
| `ts-scan.ts` | the strings a `fix:` can evaluate to, the `X_*` codes a file declares, and the ones it says it borrows |
| `error-contract.ts` | the rules, the two checks that turn them into findings, and `collectDeclaredCodes` |
| `source-files.ts` | which files are shipped source — shared with `filesize`, never a second list |

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
`serve.ts` installs neither it nor the span exporter, the same line that file already draws for
`/_x`. Installing one is the single switch that turns statement instrumentation on at all, which is
why the ledger and the exporter go in together and come out together in `stop()`: the timeline's
SQL rows and the repeat counts are one feature with one toggle, and a production process keeps
paying the one `undefined` branch the seam costs uninstalled (axiom 6).

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

## `x dev` boots the app; it does not simulate one

| File | Job |
|---|---|
| `dev-services.ts` | resolve which service each binding points at — embedded or external |
| `dev-queue.ts` | the db + queue pair alone, and the one place that takes `db()` and `jobDriver()` back |
| `dev-runtime.ts` | start the rest on top of it and install the remaining accessors (storage, mail, transport) |
| `dev-render.ts` | one HTTP route per registered `route`, through render's own mode function |
| `style-csp.ts` | the `style-src` sha256 of every inline `<style>` the web role serves |
| `dev-assets.ts` | the image pipeline's only HTTP surface: `/icons/*` and `/media/*` |
| `dev-hooks.ts` | the pipeline's `authorize` seam, decided from the app's own `Policy` objects |
| `dev-roles.ts` | `--role` selection plus start/stop for `web`, `sync`, `worker`, `scheduler` |
| `dev-dashboard.ts` | the `DevSources` hooks only this process can answer, and the two CLI panels |
| `dev-traces.ts` | core's spans → the `/_x` timeline's request traces |
| `dev-n-plus-one.ts` | statement shapes counted per request, and the ones that repeat past the threshold |
| `statement-loop.ts` | one verdict → the finding, the panel fact, the overlay notice and the log line |
| `dev-policy.ts` | which actors to ask about, and which capability each policy gates |
| `cmd-dev.ts` | boot order, mounting `/_x`, installing the span exporter, the file watcher |
| `mcp-host.ts` | the `DevCapabilities` half of `@ultimat3/mcp`'s `DevHost` — db, tests, logs, verify |
| `mcp-db-target.ts` | which database the host is pointed at, and whether it is a branch |
| `mcp-errors.ts` | `errors.explain`: one runnable command per code, typed over `CliErrorCode` |
| `error-catalog.ts` | imports every `@ultimat3/*` package so `x errors` answers for codes no command loads |
| `mcp-test-output.ts` | reading `bun test`'s own summary back into a `TestRun` |
| `cmd-mcp.ts` | `x mcp serve`: the two transports, and the local developer's caller |

`startWeb` warns when the route table declares `auth: 'required'` and the app configured no
authenticator: `hooks.authenticate` is the only place an actor can come from, so such a process
boots clean, reports healthy, and refuses every valid session. A warning and not a throw, because
`x new` scaffolds guarded routes before it scaffolds an authenticator.

The roles live in `@ultimat3/core` (`ROLES`, `isRole`), never in a second list here. A dev-only
driver, a dev-only authorizer or a dev-only queue is the bug this design exists to prevent — the
only thing dev changes is which driver is behind an interface.

### `dev-assets.ts` is where the image pipeline meets HTTP

Three packages declare what an image is and none of them serves one: `@ultimat3/seo` says what a
variant URL means (`parseImageQuery`) and produces the bytes (`builtinImageDriver`),
`@ultimat3/storage` says what a variant is called and where it is cached (`variantKey`), and
`@ultimat3/pwa` says which icons a web manifest promises (`planIcons`, `BuiltinImagePipeline`).
Pixels are `@ultimat3/core`'s pipeline, only ever. This file picks two base paths — `ICON_BASE_PATH`
and `MEDIA_BASE_PATH` — and decides nothing else; a resize, a format table or a second cache key
here is the drift the split exists to prevent.

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

## Planned commands are commands

Every command in `wiki/CLI-Reference.md`'s planned table is in the registry, built from
`PLANNED_COMMANDS` in `cmd-planned.ts`, and exits `X_NOT_IMPLEMENTED` with a `fix:` naming the
closest **shipped** command. `X_CLI_UNKNOWN_COMMAND` would say "you typed something that does not
exist", which is false and sends an agent hunting a typo. `cmd-planned.test.ts` enforces both
halves: every row is reachable through the parser, and no `fix` points at another planned command.

Implementing one means deleting its row and adding a real `cmd-<name>.ts` — the summary's
`(planned)` suffix disappears with it, and `x help` follows automatically.

Adding a command: write `cmd-<name>.ts` exporting a `CliCommand`, register it in `registry.ts`,
add its message keys to `messages.ts`. Help and parsing derive from the spec automatically. A
command's `run` must be `async`: a synchronous throw escapes every caller that awaits the promise
the signature promises, `dispatch`'s own error path included.
