# DocsSite

Ultimate's own docs site, built by Ultimate: [`wiki/*.md`](../../wiki) projected to static pages at
0 KB of script, gated by its own `x verify` as the third tracked app (`scripts/lib/gated-apps.ts`).
Scaffolded by `x new docs-site --no-example`, so it starts where a stranger starts.

| Path | Holds |
|---|---|
| `packages/docs-source` | the wiki reader: a page per wiki file, a page per `X_*` code, a page per upgrade major, every link rewritten, a dead one a build error (`X_DOCS_LINK_DEAD`) |
| `apps/web/site/[page]` · `errors/[code]` · `upgrading/[major]` | the routes, `render: 'static'`, `budget: { js: '0kb' }` |
| `apps/web/site/search` | the one page with an island: `searchDocs` from `@ultimat3/manifest/docs-search` over a static index |
| `apps/web/prerender.ts` | the static build, plus `<page>.md` beside every page and `/search-index.json` |
| `.github/workflows/deploy-docs-site.yml` (repo root) | the GitHub Pages publish, inert until `DOCS_SITE_ORIGIN` is set |

`wiki/` is never edited from here: it stays the one source, and the GitHub wiki its other projection.

## 🚀 Start

```sh
bun run setup   # prerequisites, deps, env, the first migration, migrate, seed, the manifest
bun run dev     # all roles in one process, embedded Postgres, /_x mounted
bun run verify  # the gate: typecheck, lint, boundaries, tests, drift, budgets (it builds to weigh)
```

Tests against real servers — Postgres 18, Redis, NATS, S3, in RAM and silent, as CI runs them:

```sh
docker compose -f docker/docker-compose.test.yml up -d --wait
set -a; . docker/test-services.env; set +a
bun run verify
```

`packages/db/migrations` starts empty and `x db gen` is its only writer — `bun run setup` runs
`x db gen "initial"` for you on a fresh clone. Until it has, `x verify`'s `drift` step is red
with `X_DB_DRIFT`, and that is the fix it names.

## 🗺 Layout

| Path | Holds |
|---|---|
| `apps/web/site` | static/isr, 0kb JS, SEO-critical |
| `apps/web/app` | authed, streaming, realtime |
| `apps/web/api` | actions only |
| `apps/web/shared` | tokens, primitives, actor type — a leaf |
| `apps/admin` | generated admin dashboard, MCP on |
| `packages/*` | domain, db, i18n, ui, mcp |
| `app.config.ts` | the one config file |
| `x.manifest.json` | generated facts: routes, actions, jobs, policies |
| `.mcp.json` | MCP client config: the dev tools, `bunx @ultimat3/cli mcp serve --transport stdio` |
| `apps/web/mcp.ts` | the app's own `POST /mcp`: exposed actions, behind a bearer token |
| `.github/workflows/ci.yml` | `bun run setup` then `bun run verify`, on push and pull request |
| `.github/workflows/image.yml` | after a green `ci` on the default branch: `docker/Dockerfile` to `ghcr.io`, tagged `sha-<7>`, always on `ubuntu-latest` (bash and Docker). `ci.yml` runs on `vars.CI_RUNNER`, default `ubuntu-latest` |
