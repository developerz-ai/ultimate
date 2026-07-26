# @ultimat3/cli

The `x` binary. One char during dev, one command per job, `--json` on every one of them.

## What it owns

| Command | Does | Notes |
|---|---|---|
| `x new <name>` | scaffolds the monorepo | interactive-free; auth, seeded DB, example route |
| `x dev` | every role in one process | embedded Postgres/events/storage, `/_x` mounted |
| `x build --target docker\|binary\|static` | one artifact | `ROLE` selects behaviour at start |
| `x verify` | **the gate** | 13 named steps, each with pass/fail + duration |
| `x g <primitive> <name>` | scaffolds a primitive **with a passing test** | never a TODO stub |
| `x db gen\|migrate\|reset\|studio\|branch` | everything DB | `branch` = copy-on-write clone + preview URL |
| `x mcp serve` | MCP over stdio or HTTP | read tools unrestricted in dev |
| `x doctor` | environment, ports, drift, PWA prerequisites | every finding carries a fix command |
| `x deploy` | container deploy plan | compose or helm; zero platform primitives |
| `x manifest` / `x routes` | generated facts | `x.manifest.json`, `openapi.json`, route table |

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
# {"ok":false,"command":"verify","summary":"1 of 13 steps failed","steps":[...]}
```

## `x verify` steps

`typecheck lint boundaries unit contract live job e2e eval drift contract-diff budgets manifest`

Never bails early: an agent fixing three things needs all three findings from one run.
`--only a,b` and `--skip c` narrow it; the exit code is non-zero if any step fails.

## Layout

| File | Responsibility |
|---|---|
| `bin.ts` | argv, stdout, exit code — nothing else |
| `dispatch.ts` | parse → run → render → exit; the only I/O boundary |
| `parse.ts` | flags, subcommands, `--json`, `--help`, suggestions |
| `output.ts` | one data shape, two renderers, the 3-line error format |
| `registry.ts` | the one command list |
| `cmd-*.ts` | one command group each |
| `templates/` | scaffolding as typed string modules, not copied fixtures |
| `surfaces.ts` | app import boundaries (site→app, shared leaf, route→DB) |
| `drift.ts` `openapi.ts` `budgets.ts` `manifest-scan.ts` | the checks `x verify` composes |

## Generated file layout

`x g` writes into the feature slice:

```
apps/web/app/<feature>/{entity,repo,service,policy,errors,ui}.ts
apps/web/app/<feature>/{actions,queries,live,jobs,tasks}/<name>.ts
apps/web/{site,app}/<path>/page.tsx
```

Every emitted source has a `<file>.test.ts` beside it that passes on the first run.

## Errors

`X_CLI_UNKNOWN_COMMAND` `X_CLI_BAD_FLAG` `X_VERIFY_FAILED` `X_NOT_IN_APP` `X_BUN_VERSION`
`X_NOT_IMPLEMENTED`
