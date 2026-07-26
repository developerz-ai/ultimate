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
  cause: Bun 1.2.9 is older than the required >=1.3.0
  fix:   bun upgrade
```

`x doctor --json` checks the runtime, the embedded Postgres, ports, and the resolved env, and runs outside an app directory.

## Create an app

```
bunx create-ultimate myapp && cd myapp && x dev
```

`create-ultimate` is a thin front for `x new`. Inside an existing workspace, use `x new` directly.

| Flag | Default | Effect |
|---|---|---|
| `--admin` / `--no-admin` | `--admin` | generate `apps/admin/` with its MCP surface |
| `--locale <bcp47>` | `en` | first i18n catalog + default `ctx.locale` |
| `--tz <iana>` | `UTC` | default `ctx.tz`; every date is formatted with an explicit zone |
| `--currency <iso>` | `USD` | default `Money.currency`; amounts stay integer minor units |
| `--no-install` | off | scaffold only, skip `bun install` |
| `--no-git` | off | skip `git init` and the initial commit |
| `--yes` | off | accept every default, no prompts (the agent path) |
| `--json` | off | machine-readable result: paths written, next commands |

What `x new` writes, and who owns it afterwards:

| Artifact | Author | Rule |
|---|---|---|
| `.env` | generated, **complete and valid** | dev secrets carry a loud `dev-only-` prefix. No `.env.example` to diff |
| `app.config.ts` | yours | the one config file; validated at boot ([Configuration](Configuration)) |
| `x.manifest.json` | generated every build | routes, entities, actions, jobs, policies, tags, MCP tools, budgets. Never hand-edited; drift fails `x verify` |
| `openapi.json` | generated | HTTP surface from `action` / `query` declarations |
| `AGENTS.md` / `CLAUDE.md` | **human-authored stubs** | short, terse. Ultimate never generates prose docs at runtime |
| `docker/` | generated | dev compose + per-role prod compose + Dockerfile ([Deployment](Deployment)) |

## Typed env, validated at boot

```ts
// app.config.ts
env: t.object({
  DATABASE_URL: t.string.url,
  NATS_URL:     t.string.url.optional(),
  S3_BUCKET:    t.string,
  VAPID:        t.string.optional(),
  STRIPE_KEY:   t.string.matching(/^sk_/),
}),
```

Boot parses this before any listener binds. Failure costs ~40ms and exit 1 — not a 3am `undefined` in a payment handler.

```
X_ENV_MISSING: required environment variables are missing or invalid
  cause: STRIPE_KEY missing; NATS_URL is not a URL ("nats:4222")
  fix:   x env check --fix
```

| Property | Behavior |
|---|---|
| Access | `env.STRIPE_KEY` is typed. A `process.env` read outside the schema is a lint error |
| Per-role | a role requires only the keys it uses — `ROLE=worker` does not fail on a missing `VAPID` |
| Repair | `x env check --fix` writes the missing keys to `.env` with placeholders |
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
| Bun image | `sharp` + libvips + `imagemin` plugins | ~12 |
| `Bun.password` | `bcrypt` / `argon2` native addons | ~4 |
| `Bun.file` / `Bun.write` | `fs-extra`, `graceful-fs`, `globby` | ~6 |
| `bun --hot` | `nodemon`, `concurrently`, HMR middleware | ~5 |

Stated cost: no native-addon packages, and Bun's long-running-process maturity is less proven than Node's.

## Editor and agent setup

`x dev` starts an MCP server on the dev socket (`ws://localhost:9229` by default). Point your agent at it and it stops guessing.

```
claude mcp add ultimate --transport ws ws://localhost:9229
```

| Tool | Replaces the agent's usual guess |
|---|---|
| `routes.list` | grepping a router directory |
| `schema.describe` | reading migration files in order |
| `policies.list` | "is this endpoint protected?" |
| `actions.list` | reading `api/` by hand |
| `manifest.get` | ten separate reads |
| `tests.run` | parsing terminal output |
| `logs.tail` | scrollback archaeology |
| `db.query` | inventing a query and hoping (read-only, row-capped) |
| `db.migrate` | mutating the dev DB — writes land in a **branch DB only** |
| `errors.explain` | a web search for an error string |
| `budgets.report` | bisecting bundles |

Read tools are unrestricted in dev; write tools are scoped to branch environments. The dev server is never exposed under `ROLE=web`. Use `x mcp` for a standalone server (CI, remote agents). Editor config: Biome is the only formatter/linter — one binary, one config, no ESLint or Prettier.

## Upgrading and removal

| Task | Command |
|---|---|
| Framework version bump + codemods | `x upgrade` |
| Check what a bump would change | `x upgrade --dry-run --json` |
| Remove dev state (embedded PG, storage, caches) | `rm -rf .x` |
| Remove the CLI | it ships with the app; deleting the repo is the uninstall |

Version pinning: `As of 2026-07`, Bun 1.3 is the floor and 2.0 the target; SolidJS 2 is in beta; ArkType and Drizzle are pinned exactly and their upgrades are framework work, not app work. Details and codemod inventory in [Upgrading](Upgrading). Boot failures and port conflicts in [Troubleshooting](Troubleshooting).
