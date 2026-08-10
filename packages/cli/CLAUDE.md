# @ultimat3/cli — boundary

Tier 5. May import tiers 0–4. Nothing imports this except `create-ultimate`.

| Rule | Detail |
|---|---|
| Entry | `src/bin.ts` (`#!/usr/bin/env bun`) — argv, stdout, exit code only |
| I/O | only `dispatch.ts` renders or exits; commands return `CommandResult` |
| `--json` | every command, no exceptions — same data as the human render |
| Errors | `src/errors.ts`, subclass `UltimateError`, never a bare `Error` |
| Subprocesses | only through `exec.ts`, so a test can inject a fake `Runner` |
| Templates | `templates/*.ts` return strings; no fixture files on disk |
| Strings | `messages.ts` flat catalog, missing key renders `⟦key⟧` |
| Facts | load the app (`app-load.ts`), then project it — never parse source for primitives |

Every fact the CLI reports comes from a framework package: the manifest from
`@ultimat3/manifest`, `openapi.json` from `@ultimat3/action`, the route table from
`@ultimat3/render`, budget units from `@ultimat3/render`, the `/_x` panels from
`@ultimat3/admin`, the MCP tool catalog from `@ultimat3/mcp`, eval coverage from
`@ultimat3/ai`. A check that reimplements one of those here is the bug, not the fix.

`app-evals.ts` is why the `eval` step can apply with no eval suite at all: a prompt no eval
names is `X_EVAL_MISSING`, and a skipped step would read as a green gate over untested code.

## The `errors` step enforces the error contract

| File | Job |
|---|---|
| `ts-scan.ts` | the strings a `fix:` can evaluate to, and the `X_*` codes a file declares |
| `error-contract.ts` | the rules, and the two checks that turn them into findings |
| `source-files.ts` | which files are shipped source — shared with `filesize`, never a second list |

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
holds — a SQL runner, the committed manifest, the process's own services — supplied as
`defaultDevSources({ hooks })`.

## `x dev` boots the app; it does not simulate one

| File | Job |
|---|---|
| `dev-services.ts` | resolve which service each binding points at — embedded or external |
| `dev-runtime.ts` | start them and install the ambient accessors (`db()`, `jobDriver()`, storage, transport) |
| `dev-render.ts` | one HTTP route per registered `route`, through render's own mode function |
| `dev-hooks.ts` | the pipeline's `authorize` seam, decided from the app's own `Policy` objects |
| `dev-roles.ts` | `--role` selection plus start/stop for `web`, `sync`, `worker`, `scheduler` |
| `dev-dashboard.ts` | the `DevSources` hooks only this process can answer, and the two CLI panels |
| `cmd-dev.ts` | boot order, mounting `/_x`, the file watcher |
| `mcp-host.ts` | the `DevCapabilities` half of `@ultimat3/mcp`'s `DevHost` — db, tests, logs, verify |
| `mcp-db-target.ts` | which database the host is pointed at, and whether it is a branch |
| `mcp-errors.ts` | `errors.explain`: one runnable command per code, typed over `CliErrorCode` |
| `error-catalog.ts` | imports every `@ultimat3/*` package so `x errors` answers for codes no command loads |
| `mcp-test-output.ts` | reading `bun test`'s own summary back into a `TestRun` |
| `cmd-mcp.ts` | `x mcp serve`: the two transports, and the local developer's caller |

The roles live in `@ultimat3/core` (`ROLES`, `isRole`), never in a second list here. A dev-only
driver, a dev-only authorizer or a dev-only queue is the bug this design exists to prevent — the
only thing dev changes is which driver is behind an interface.

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
