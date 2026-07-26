# create-ultimate

```sh
bunx create-ultimate myapp && cd myapp && x dev
```

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
