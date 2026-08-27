# Installation

## Prerequisites

| Requirement | Version | Needed for | Notes |
|---|---|---|---|
| Bun | **>= 1.3** (target 2.0) | everything | the only runtime. No Node, Deno, or workerd support — ever |
| Postgres | 16+ | prod, parity checks | **optional in dev** — `x dev` embeds one in `.x/pg` |
| Docker | any | parity checks, prod images | never required for `x dev`; `x build --target docker` needs it |
| Redis | 7+ | cache tier 3 in prod | dev uses an in-process map behind the same interface |
| NATS | 2.10+ | fanout in prod | dev runs it in-process |
| Native toolchain | — | **nothing** | no native addons in the dependency graph; no `node-gyp`, no `sharp`, no `libvips` |

Bun below the floor fails before anything else runs:

```
X_BUN_VERSION: bun version is below the framework floor
  cause: Bun 1.3.12 is older than the required >=1.4.0
  fix:   bun upgrade
```

`x doctor --json` checks the runtime, the embedded Postgres, ports, and the resolved env, and runs outside an app directory.

## Create an app

```
bunx create-ultimate myapp && cd myapp && bin/setup && x dev
```

`create-ultimate` is a thin front for `x new`. Inside an existing workspace, use `x new` directly.

**`bin/setup` is not optional.** `x new` writes files and installs nothing, so `cd myapp && x dev`
stops on `X_BUILD_FAILED` naming `bun install` (measured `As of 2026-08-23`; this page said
otherwise until then). `bin/setup` is `bun install`, `x db gen "initial"`, `x db migrate`,
`x db seed` — idempotent, safe to re-run.

Every flag, from the registry — `bun run x -- help new`, or `x help new` in an app. There are five,
each with a default, so **`x new` asks nothing**: an agent cannot answer a prompt and is never given
one.

| Flag | Default | Effect |
|---|---|---|
| `--dir <path>` | cwd | parent directory the app is written into |
| `--example` / `--no-example` | `--example` | include the example feature slice; `--no-example` gives the same shape with an empty `app/` |
| `--git` / `--no-git` | `--git` | `git init` and commit the scaffold |
| `--dry-run` | off | print the file list, write nothing |
| `--force` | off | write into a directory that already exists |
| `--json` | off | machine-readable result: the directory, every path written, the git outcome |

There is **no** `--admin`, `--locale`, `--tz`, `--currency`, `--no-install` or `--yes` — this table
listed all six until 2026-08-23 and the parser refuses each with `X_CLI_BAD_FLAG`. `apps/admin/` is
always written; locale, timezone and currency are `app.config.ts` fields you edit after scaffolding
([Configuration](Configuration)).

What `x new` writes, and who owns it afterwards:

| Artifact | Author | Rule |
|---|---|---|
| `.env.development` | generated, **complete and valid**, committed | non-secret defaults; per-box secrets go in `.env.development.local`, which wins. Dev secrets carry a loud `dev-only-` prefix. The scaffold writes no `.env` — Bun still loads `.env`, `.env.<mode>` and `.env.local` when they exist ([`packages/core/src/env-example.ts:31`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/env-example.ts)), and `.env` is the one you never commit |
| `.env.example` | generated from `envSchema` | never hand-edited — it is a projection of the declaration, and drift fails `x verify`. Regenerate with `x env example` |
| `app.config.ts` | yours | the one config file; validated at boot ([Configuration](Configuration)) |
| `x.manifest.json` | generated every build | routes, entities, actions, jobs, policies, tags, MCP tools, budgets. Never hand-edited; drift fails `x verify` |
| `openapi.json` | generated | HTTP surface from `action` / `query` declarations |
| `AGENTS.md` / `CLAUDE.md` | **human-authored stubs** | short, terse. Ultimate never generates prose docs at runtime |
| `docker/` | generated | dev compose + per-role prod compose + Dockerfile ([Deployment](Deployment)) |
| `packages/db/migrations/` | **not written at all** | `x db gen` is its only writer, `As of 2026-08`. First commands in a new app: `x db gen "initial"`, then `x db migrate` — `bin/setup` runs both. Until the first one has, `x verify`'s `drift` step is red and names it, for any app declaring an entity; `--no-example` declares none, and zero against zero is agreement |

## Typed env, validated at boot

Declared at module scope in `app.config.ts`, next to `defineConfig`. There is no `env.ts` — `app.config.ts` is the one file the CLI and the runtime both load, so it is the one place the env gate can run before anything binds.

```ts
// app.config.ts
import { defineConfig, defineEnv } from '@ultimat3/core';

export const env = defineEnv({
  DATABASE_URL: { type: 'url' },
  NATS_URL:     { type: 'url', required: false },
  S3_BUCKET:    { type: 'string' },
  VAPID:        { type: 'string', required: false },
  STRIPE_KEY:   { type: 'string', pattern: /^sk_/, secret: true },
});

export const config = defineConfig({ name: 'myapp' /* … */ });
```

Boot parses this before any listener binds. Failure costs ~40ms and exit 1 — not a 3am `undefined` in a payment handler.

```
X_ENV_MISSING: required environment variables are missing or invalid
  cause: STRIPE_KEY missing; NATS_URL is not a URL ("nats:4222")
  fix:   add STRIPE_KEY, NATS_URL to .env (copy .env.example), then run: x env check
```

The `fix:` is per-key and built from your own declarations ([`packages/core/src/env.ts:237`](https://github.com/developerz-ai/ultimate/blob/main/packages/core/src/env.ts)); `defineEnv({ KEY: { fix } })` overrides it for one key.

| Property | Behavior |
|---|---|
| Access | `env.STRIPE_KEY` is typed. A `process.env` read outside the schema is a lint error |
| Per-role | a role requires only the keys it uses — `ROLE=worker` does not fail on a missing `VAPID` |
| Repair | `x env example` regenerates `.env.example` from the schema; copy the keys it names into `.env.development.local` in dev, or into your platform's secret store in production. There is **no** `x env --fix` — `x env` declares `check` and `example` and no flags, so `x env check --fix` dies at the parser with `X_CLI_BAD_FLAG` |
| CI | `x env check` runs inside `x verify`, against the schema — never against a checked-in example file |
| Provenance | `/_x` → **Env** shows every resolved key and which source it came from |

## What Bun natives replace

Each row is a dependency subtree that never enters the lockfile. Target: **under 40 direct dependencies for the whole framework**.

| Bun primitive | Replaces | Deps killed (approx) |
|---|---|---|
| `Bun.sql` | `pg`, `pg-pool`, `pg-connection-string`, `postgres`, pool wrappers | ~8 |
| `Bun.redis` | `ioredis` / `redis` + command/parser packages | ~5 |
| `Bun.s3` | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` + AWS SDK core | ~25 |
| `Bun.serve` WebSockets | `ws`, `socket.io`, `engine.io`, `uWebSockets.js` | ~10 |
| `bun test` | `vitest` / `jest`, `@types/jest`, coverage + mock + snapshot plugins | ~30 |
| `Bun.build` | `esbuild` / `rollup` / `vite` + framework plugin + postcss chain | ~40 |
| `Bun.Transpiler` / macros | `ts-node`, `tsx`, `swc`, babel presets | ~15 |
| `Bun.password` | `bcrypt` / `argon2` native addons | ~4 |
| `Bun.file` / `Bun.write` | `fs-extra`, `graceful-fs`, `globby` | ~6 |
| `bun --hot` | `nodemon`, `concurrently`, HMR middleware | ~5 |

One more subtree dies with no Bun native behind it — a pure-TypeScript framework pipeline, written because native addons are blocked:

| Framework primitive | Replaces | Deps killed (approx) |
|---|---|---|
| `@ultimat3/core` image | `sharp` + libvips + `imagemin` plugins | ~12 |

Stated cost: no native-addon packages, and Bun's long-running-process maturity is less proven than Node's.

## Editor and agent setup

The MCP server is `x mcp serve`, and **`x dev` does not start one** — measured `As of 2026-08-23`,
`/mcp` on the dev server answers 404 and nothing listens on 9229 until this command runs. It prints
the bearer token and the scopes the caller gets:

```
x mcp serve --transport stdio                  # a client that spawns the server
x mcp serve --transport http --port 9229       # POST /mcp; the bearer token is printed at boot
```

`stdio` and `http` are the two transports (`x help mcp`) — there is no `ws` transport, and this page
told readers to configure one until 2026-08-23. Register the URL and the printed token with whatever
MCP client you use; a request without the token is answered 401 with no catalog.

Thirteen tools, `As of 2026-08` — the full catalog, and the exact names to call:

| Tool | Replaces the agent's usual guess |
|---|---|
| `routes.list` | grepping a router directory |
| `schema.describe` | reading migration files in order |
| `policies.list` | "is this endpoint protected?" |
| `actions.describe` | reading `api/` by hand — actions and queries in one call |
| `jobs.inspect` | reading `jobs.ts` for retry policy and step names |
| `queue.depth` | guessing whether the worker is keeping up |
| `manifest.read` | ten separate reads |
| `errors.explain` | a web search for an error string |
| `db.query` | inventing a query and hoping (read-only; 100-row default, 1000-row maximum) |
| `db.migrate` | mutating the dev DB — writes land in a **branch DB only** |
| `tests.run` | parsing terminal output |
| `verify.run` | guessing whether the work is shippable |
| `logs.tail` | scrollback archaeology |

Read tools are unrestricted in dev; write tools are scoped to branch environments. The dev server is never exposed under `ROLE=web`. `db.query` refuses a batch, a write keyword anywhere at statement level (a data-modifying CTE included), a locking clause, `EXPLAIN ANALYZE`, and the banned function families matched by prefix (`pg_read_*`, `pg_ls_*`, `lo_*`, `pg_advisory_*`, `pg_sleep*`, `set_config`, …) — `X_MCP_QUERY_REJECTED`, before the host sees the string. Use `x mcp` for a standalone server (CI, remote agents). Editor config: Biome is the only formatter/linter — one binary, one config, no ESLint or Prettier.

## Upgrading and removal

| Task | Command |
|---|---|
| Framework version bump + codemods | `x upgrade` — **planned**, exits `X_NOT_IMPLEMENTED`. The shipped path is `bun update --latest && x verify`, then pin every `@ultimat3/*` to one exact version |
| Check what a bump would change | nothing shipped does this. `x upgrade --dry-run` is worse than unimplemented: a planned command declares no flags, so it dies at the parser with `X_CLI_BAD_FLAG` instead of the honest `X_NOT_IMPLEMENTED`. Read `CHANGELOG.md` — `grep -c 'BREAKING —' <that section>` is the count, and it is `[Unreleased]`'s to change on any commit ([Upgrading](Upgrading)) |
| Remove dev state (embedded PG, storage, caches) | `rm -rf .x` |
| Remove the CLI | it ships with the app; deleting the repo is the uninstall |

Version pinning: `As of 2026-08`, Bun 1.3 is the floor and 2.0 the target; SolidJS 2 is in beta and is pinned exactly, and its upgrade is framework work, not app work. There is no ArkType or Drizzle pin to carry — `@ultimat3/schema` ships its own dependency-free validators and `@ultimat3/entity` its own `postgresDriver()`. Details and codemod inventory in [Upgrading](Upgrading). Boot failures and port conflicts in [Troubleshooting](Troubleshooting).
