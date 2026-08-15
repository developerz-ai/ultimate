# @ultimat3/cli

The `x` binary. One char during dev, one command per job, `--json` on every one of them.

## What it owns

Commands and the `x verify` step count, `As of 2026-08`:

| Command | Does | Notes |
|---|---|---|
| `x new <name>` | scaffolds the monorepo | interactive-free; auth, seeded DB, example route |
| `x dev` | every role in one process | embedded Postgres/events/storage, `/_x` mounted |
| `x build --target docker\|binary\|static` | one artifact | `ROLE` selects behaviour at start |
| `x verify` | **the gate** | 17 named steps, each with pass/fail + duration |
| `x g <primitive> <name>` | scaffolds a primitive **with a passing test** | never a TODO stub |
| `x db gen\|migrate\|reset\|studio\|branch` | everything DB | `branch` = copy-on-write clone + preview URL |
| `x mcp serve` | `@ultimat3/mcp`'s 13 dev tools, over stdio or HTTP | one catalog, one scope set, both transports |
| `x doctor` | environment, ports, drift, PWA prerequisites | every finding carries a fix command |
| `x deploy` | container deploy plan | compose or helm; zero platform primitives |
| `x manifest` / `x routes` | generated facts | `x.manifest.json`, `openapi.json`, route table |
| `x actions` / `x queries` / `x entities` | the declaration registries | `list` and `describe <name>`, straight off the registries |
| `x jobs ls\|show\|retry\|drain` | the queue | depth, dead letters, step traces, `retry --from-step`, `drain --to` |
| `x test [type]` | one of the six test types, or all | same type rule as the gate; `--filter`, `--sample N` |
| `x errors explain <CODE>` | the error table, programmatically | refuses an unregistered code instead of inventing one |
| `x fix boundary <file>` | the minimal cut for a crossed surface boundary | prints the plan and the `git mv`; never rewrites a file |

Everything in [CLI reference](../../wiki/CLI-Reference.md)'s planned table is also in the registry
and exits `X_NOT_IMPLEMENTED` with a `fix:` naming the closest shipped command — "not built yet"
and "not a command" are different facts.

## The output contract

Every command returns one `CommandResult`; the human renderer and the JSON renderer are
projections of it, so `--json` can never drift from the terminal.

```
X_DB_DRIFT: schema differs from migrations
  cause: table "posts" has column "publish_at" not present in any migration
  fix:   x db gen "add publish_at"
```

```sh
x verify --json
# {"ok":false,"command":"verify","summary":"1 of 16 steps failed","steps":[...]}
```

## `x verify` steps

`typecheck lint boundaries filesize package-shape errors unit contract live job e2e eval drift
contract-diff budgets manifest`

One list, in cost order, defined once in `cmd-verify.ts` — the framework repo's own gate
(`bun run verify`) runs exactly it. A step with nothing to check here reports as skipped, never as
passed. Never bails early: an agent fixing three things needs all three findings from one run.
There is no `--only` and no `--skip`; the exit code is non-zero if any step fails.

An app extends the gate with its own conventions, never with its own step: a file in `guards/`
exports a `guard` whose `check(root)` returns `Finding[]`, and the `boundaries` step runs every one
of them. Nothing registers a guard — the directory is the registration — and what a guard returns
is held to the same error contract shipped source is (`X_GUARD_INVALID`, `X_GUARD_FAILED`,
`X_GUARD_FINDING_INVALID`). `x g guard <name>` scaffolds one with its test.

## Layout

| File | Responsibility |
|---|---|
| `bin.ts` | argv, stdout, exit code — nothing else |
| `write-line.ts` | the synchronous fd-1 write both published entry points use (`create-ultimate`'s too) |
| `dispatch.ts` | parse → run → render → exit; the only I/O boundary |
| `parse.ts` | flags, subcommands, `--json`, `--help`, suggestions |
| `flag-number.ts` | the one integer-flag reader — `--port`, `--workers`, `--shard` |
| `output.ts` | one data shape, two renderers, the 3-line error format |
| `registry.ts` | the one command list |
| `generate-kinds.ts` | which generators exist, and how a command line names one |
| `guards.ts` | the app's own conventions: `guards/` discovered, run, and held to the error contract |
| `cmd-*.ts` | one command group each |
| `templates/` | scaffolding as typed string modules, not copied fixtures |
| `app-load.ts` | import an app's modules so the framework registries hold it |
| `app-manifest.ts` | `x.manifest.json`, projected by `@ultimat3/manifest` |
| `app-openapi.ts` | `openapi.json`, projected by `@ultimat3/action` |
| `app-boundaries.ts` | app import boundaries, over `@ultimat3/render`'s surface check |
| `app-agents-md.ts` | `AGENTS.md` exists and stays short, over `@ultimat3/manifest`'s check |
| `dev-*.ts` | what `x dev` boots: services, runtime, routes, hooks, roles, the `/_x` mount |
| `island-bundle.ts` | every `*.island.tsx` built as its own entry point, content-hashed |
| `island-routes.ts` | the one route those chunks are served from, in dev and in the container |
| `mcp-host.ts` | the shell-side half of `@ultimat3/mcp`'s dev server — db, tests, logs, verify |
| `verify-step.ts` | the step shape, the step names, the host-check hook |
| `verify-tests.ts` | one `bun test` invocation per test type |
| `workspace-checks.ts` | file-size ceiling and package contract files |
| `drift.ts` `budgets.ts` | the checks `x verify` composes |

The CLI describes an app by **loading** it, never by parsing it: `action()`, `entity()`,
`job()` and `defineRoute()` register themselves, and `x manifest`, `x routes` and `x verify`
read the same tables the running server reads. There is no second definition of a primitive,
no second OpenAPI builder and no second surface-boundary walk anywhere in this package.

## Generated file layout

`x g` writes into the feature slice:

```
apps/web/app/<feature>/{entity,repo,service,policy,errors,ui}.ts
apps/web/app/<feature>/{actions,queries,live,jobs,tasks}/<name>.ts
apps/web/{site,app}/<path>/page.tsx
apps/web/{site,app}/<path>/<name>.island.tsx     # x g island <name> --at <dir>
apps/admin/src/pages/<name>.tsx                  # x g admin:page <name> --permission p
guards/<name>.ts                                 # x g guard <name>
```

Every emitted source has a `<file>.test.ts` beside it that passes on the first run.

## Errors

`X_CLI_UNKNOWN_COMMAND` `X_CLI_BAD_FLAG` `X_VERIFY_FAILED` `X_NOT_IN_APP` `X_BUN_VERSION`
`X_NOT_IMPLEMENTED` `X_GUARD_INVALID` `X_GUARD_FAILED` `X_GUARD_FINDING_INVALID`
