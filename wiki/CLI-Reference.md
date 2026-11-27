# CLI reference

The binary is `x`. One command registry — a command that is not in it does not exist, and there is no second place to register one.

```bash
x help                 # the catalogue
x help <command>       # usage for one command; a name no command has is X_CLI_UNKNOWN_COMMAND
x <command> --help     # the same thing, except on db and mcp — see Subcommands below
x version              # CLI version
```

| Convention | Detail |
|---|---|
| `--json` | every command accepts it and prints a single machine-readable object on stdout. Human output goes to stdout too, but never mixed with JSON |
| Exit codes | `0` success · `1` the command failed (a typed `X_*` error is printed) · `2` usage error (`X_CLI_BAD_FLAG`, `X_CLI_UNKNOWN_COMMAND`) |
| Errors | always `code` + `cause` + `fix`. See [Error codes](Error-Codes) |
| App detection | most commands walk up for `app.config.ts` and fail with `X_NOT_IN_APP` if there is none. The exceptions: `new`, `test`, `doctor`, `errors`, `docs`, `affected`, `ci`, `pr`, `help`, `version` |
| Flags | long form only, `--flag value` or `--flag=value`. Booleans negate as `--no-<flag>` |
| Global flags | `--json` / `-j`, `--help` / `-h`, `--cwd <dir>`, `--verbose` — accepted by every command. `--verbose` carries each step's captured output on a green run too, in the terminal and under `--json` alike (`steps[].output`); without it a step's output appears only when it fails. `As of 2026-10` |
| Subcommands | when a command has them, its default is **declared**, never positional: `x actions` is `x actions list` because that command sets `defaultSubcommand: 'list'`. A command with no defensible default declares none and refuses the bare form with `X_CLI_BAD_FLAG` — exactly `db` and `mcp`, pinned by `parse.test.ts`. `--help` is read before the subcommand, so `x db --help` and `x mcp --help` print usage like `x help db`. The parser answered `subcommands[0]` until 1.2.0, which is why `x db` used to run the migration **generator** |
| Passthrough | a bare `--` sends everything after it to the underlying tool untouched |
| Telemetry | none written. The gate proves one thing: every host a string literal in a non-test `packages/cli/src` file spells is reserved or a reasoned row in `scripts/cli-outbound.ts`, else `X_CLI_OUTBOUND_UNDECLARED`. A host built at run time, and every other package, is outside it ([FAQ](FAQ#does-ultimate-collect-anything)) |
| `--json` shape | `{ ok, command, summary, steps?, findings?, data? }`. Findings are `{ code, cause, fix, docs?, at?, meta? }` |

## Pages

The reference is split by family; every command heading keeps its anchor on the page that holds it.

| Page | Commands |
|---|---|
| this page | conventions, global flags, the command index, planned commands, names that moved |
| [Project](CLI-Reference-Project) | `x new`, `x dev`, `x stop`, `x g` |
| [Data](CLI-Reference-Data) | `x db`, `x jobs`, `x tasks`, `x cache` |
| [The gate and tests](CLI-Reference-Gate) | `x verify`, `x exercise`, `x drill`, `x test`, `x clean`, `x affected`, `x policy`, `x i18n` |
| [Build, deploy and run](CLI-Reference-Ship) | `x build`, `x deploy`, production roles, `x secrets`, `x auth`, `x vapid`, `x status`, `x heavy`, `x config` |
| [Inspect, diagnose and upgrade](CLI-Reference-Tools) | every other command |

## Command index

`As of 2026-10`. **shipped** = implemented in `packages/cli`; **planned** = specified, not yet built — calling it exits with `X_NOT_IMPLEMENTED` and a `fix:` line pointing at the closest shipped command.

| Command | Does | Status |
|---|---|---|
| `x new <name>` | scaffold a monorepo that already runs | shipped |
| `x dev` | all roles in one process: embedded services, sub-second reload, `/_x` mounted | shipped |
| `x stop [--timeout 30s]` | stop this checkout's `x dev` (the pid its `.x/dev.lock` names, nothing else) and return once the next `x dev` can boot | shipped |
| `x g <kind> <name>` | scaffold a primitive with its test | shipped |
| `x db <sub>` | gen, migrate, rollback, reset, seed, branch, backfill, diagnostics, recount, status | shipped |
| `x verify [--only <step>[,<step>…] [--shard i/n [--timings f]] \| --changed [--base <ref>] [--dirty]] [--workers N] [--isolate]` · `x verify merge <part.json…>` · `x verify plan [--parts n]` | the gate — 21 steps, in this order: typecheck, lint, boundaries, filesize, package-shape, errors, unit, contract, live, job, exercise, e2e, eval, drift, contract-diff, budgets, seo, i18n, policy, manifest, roadmap. `--only <step>[,<step>…]` runs the named steps, in one process and in gate order, for an iteration loop and announces `NOT A GATE RUN` in the summary and in `--json` (`data.notAGateRun`, `data.only` — always a list), writing no floor file; an unknown name is refused with every valid name and the nearest match. **The gate is this command with no flag.** There is no `--skip` | shipped |
| `x env [check\|example\|init]` | validate the process env against `envSchema`, regenerate `.env.example` from it, or write `.env.production` (`init --production`) | shipped |
| `x secrets <sub>` | the committed encrypted secrets file: show, init, edit, set, rotate | shipped |
| `x auth seal-mfa` | one-shot: seal every second-factor secret still stored in the clear | shipped |
| `x vapid [show\|create]` | the Web Push key pair: which one this app signs with, or mint one and seal both halves | shipped |
| `x build` | container image, single binary, prerendered static site, or a prebuilt bundle (`--target docker\|binary\|static\|prebuilt`) | shipped |
| `x deploy` | run the container deploy plan: migrate first, then the serving roles | shipped |
| `x manifest` | regenerate `x.manifest.json` and `openapi.json` | shipped |
| `x routes` | every served route: pages, then actions, queries and runtime.ts routes | shipped |
| `x mcp serve` · `x mcp tools` | serve the framework MCP tools over stdio or HTTP · list them | shipped |
| `x mcp lock <name> [--check]` | fetch the remote MCP server `mcpTools({ name })` names and write its allowed tools to `tools.lock.json` · `--check` writes nothing and fails on drift (`X_MCP_REMOTE_TOOL_CHANGED`) | shipped |
| `x doctor` | environment, versions, drift, the newest migration's snapshot sidecar, ports, PWA prerequisites — each with a fix | shipped |
| `x help` / `x version` | catalogue and version | shipped |
| `x actions` / `x queries` / `x entities` | introspect the declaration registries | shipped |
| `x jobs` | list, show, retry, cancel, remove and promote jobs; pause and resume a queue · `drain` was removed from the registry `As of 2026-11-15` ([Known gaps](Known-Gaps#open-by-decision)) | shipped |
| `x tasks` | cron tasks, their timezone and their next run; fire one now | shipped |
| `x policy` | which clause decided a permission, and why | shipped |
| `x exercise [<name>] [--seed n\|random] [--shard i/n]` | run every action, query, job and route `load` once on generated rows, with no test written; the gate's `exercise` step | shipped |
| `x drill [<name>] [--list] [--budget-ms n]` | the app's roles as real processes on real Postgres, Redis and NATS, each dependency faulted through a proxy, each role signalled, or every role started before `ROLE=migrate`, red on any framework contract that does not hold. Not a gate step: it needs the services | shipped |
| `x i18n` | add, sync, check, split catalogs | shipped |
| `x mail preview <id>` | render a mail's declared `preview` in every locale, nothing sent | shipped |
| `x test <type>` | run one of the six test types, or the whole suite | shipped |
| `x clean [--dry-run] [--services]` | remove what test runs leave behind: migrated test templates, `.x/cache`, stray `.x` folders, stale probe databases; `--services` stops this checkout's test stack and lists the machine's others | shipped |
| `x affected` | the workspaces a diff can have broken, transitively | shipped |
| `x graph [--from <a> --to <b>]` · `x impact <file\|primitive\|entity>` | the app as one typed graph, each edge `declared`, `import` or `observed` · what an edit reaches | shipped |
| `x client vendor <name>` · `x client customer --out <dir>` | one OpenAPI compiler, two clients: a third party's document into `apps/web/clients/<name>/` (`outbound()` + `t` schemas), or the app's own published document into a client with no framework import | shipped |
| `x shot <route>` | photograph one route from a real browser, plus a `verdict.json` a picture cannot carry | shipped |
| `x pr review\|resolve\|reply` | inline review threads — the ones `gh pr view --comments` does not show — plus every review verdict, every PR comment, and which review bots did not review | shipped |
| `x ci` | the workflow runs for this branch, and the findings inside the failed step's log; `x ci tested`: whether a push reuses a green PR run | shipped |
| `x errors explain <CODE>` | code → cause, fix, docs; inside an app, its own `defineError()` code → title, HTTP status and the declaring `file:line` | shipped |
| `x docs "<question>"` | framework docs and this wiki, offline, from the install — the first lookup | shipped |
| `x fix boundary <file>` | plan the minimal cut for an import that crossed a surface boundary (never rewrites) | shipped |
| `x upgrade` | one major per run: exact pins, the Bun floor, `bun install`, the release's codemods, the gate, the section to read · `x upgrade codemods` | shipped |
| `x token create\|list\|revoke` | MCP and API tokens in the app's `x_api_keys`: issue one with exact scopes (plaintext shown once), list an owner's, revoke one · `grant` was removed from the registry `As of 2026-11-15` ([Known gaps](Known-Gaps#open-by-decision)) | shipped |
| `x config show [--section <key>]` | the resolved `app.config.ts`, defaults merged, credentials redacted | shipped |
| `x logs tail [--lines n] [--role <role>]` | the last lines of `.x/dev.log`, or one role's (its `.x/logs/<role>.log`, else its lines of the dev log) — the `logs.tail` MCP tool's reader | shipped |
| `x cache graph\|bust <tag>\|clear` | the tag graph off the manifest (what each write evicts), a bust of one tag or every declared tag through the app's own tiers and bus · `stats` was removed `As of 2026-11-15` ([Known gaps](Known-Gaps#open-by-decision)) | shipped |
| `x explain <query> [--input <json>] [--org <id>]` | one declared query run once on the dev database, every statement it sent planned by the `exercise` step's oracle | shipped |
| `x profile <route> [--runs 20] [--top 10]` | a CPU profile of rendering one route in this process: the hottest functions, file and line | shipped |
| `x merge-driver install` · `x merge-driver run <base> <ours> <theirs> <path>` | installs the git merge drivers for this clone (a step of `bun run setup`); `run` is what git calls for a registry both branches changed. [Merging two features](Many-Agents#merging-two-features) | shipped |
| `x heavy [status]` · `x heavy run [--label s] [--mb n] [--max-wait s] -- <command…>` | the machine's shared memory ledger: who runs, who is queued, load and memory; any command run inside one reservation, its exit code passed through | shipped |
| `x status [--url <origin>] [--samples n]` | the build each live worker runs (`x_job_workers`), and the build, status and role each sampled origin's `/readyz` answers | shipped |

## Planned commands

None, `As of 2026-11-16`. The table is `PLANNED_COMMANDS` in `packages/cli/src/cmd-planned.ts`, and it is empty, and the registry builds no command from it: the last three left with plan 101b slice 13. `x branch`, `x ai` and `x money` are each a row in [Known gaps](Known-Gaps) with the decision ("not planned") and the extension point that does the job today, and the parser refuses each with `X_CLI_UNKNOWN_COMMAND`. `PLANNED_SUBCOMMANDS`, the one-level-down version, has been empty since `As of 2026-11-15` (`x db studio`, `x jobs drain`, `x token grant` and `x cache stats` went the same way). `cmd-planned.test.ts` holds both tables empty.

`x token`, `x config`, `x logs` and `x cache` left this table `As of 2026-11` (plan 101-full-stack-efficiency-sweeps U5), `x status` `As of 2026-11-15`; each has its section above.

## Names that moved

| Older name in the design docs | Use instead |
|---|---|
| `x db apply` | `x db migrate` |
| `x gen <kind>` | `x g <kind>` (or `x generate`) |
| `x deploy compose` / `x deploy static` | `x deploy --method compose` / `x build --target static` |
| `x mcp` (bare) | `x mcp serve` |
| `x routes list` | `x routes` |

Related: [Getting started](Getting-Started) · [Configuration](Configuration) · [Testing](Testing) · [Deployment](Deployment) · [Troubleshooting](Troubleshooting).
