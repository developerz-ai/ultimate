# create-ultimate

```sh
bunx create-ultimate myapp && cd myapp && bin/setup && x dev
```

`bin/setup` is the scaffold's own script and it is not optional: `x new` writes files and installs
nothing, so `x dev` on the tree it just wrote fails with `X_BUILD_FAILED`. The script installs the
dependencies, writes `.env.development.local`, generates and applies the first migration, and
seeds — idempotent, so it is safe to re-run after every pull.

Thin wrapper over `x new` — same templates, same flags, no second code path.

| Flag | Does |
|---|---|
| `--dir <path>` | parent directory (default: cwd) |
| `--no-example` | skip the example feature slice |
| `--dry-run` | print the file list, write nothing |
| `--json` | machine-readable output |

What you get: `apps/web/{site,app,api,shared}`, `apps/admin` with MCP on, `apps/{mobile,desktop}`
placeholders, `packages/{domain,db,i18n,ui,mcp}`, `bin/`, `docker/`, `app.config.ts` — a landing
page at 0kb JS, a streaming authed dashboard, a seeded database and `x verify` green.
