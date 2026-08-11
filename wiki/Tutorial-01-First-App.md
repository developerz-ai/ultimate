# Tutorial 1 — your first app

One command scaffolds a monorepo that already runs. No Docker daemon, no database to provision, no `.env` to fill in.

v1.1.0 `As of 2026-08`. Every command and every output on this page was executed against `create-ultimate@1.1.0` from npm.

Series: **1** · [2 — first feature](Tutorial-02-First-Feature) · [3 — auth and admin](Tutorial-03-Auth-And-Admin) · [4 — jobs and realtime](Tutorial-04-Jobs-And-Realtime) · [5 — deploy free](Tutorial-05-Deploy-Free) · [6 — growing up](Tutorial-06-Growing-Up)

## Prerequisites

| Need | Version | Check |
|---|---|---|
| Bun | ≥ 1.3.0 | `bun --version` |
| Docker | only for [tutorial 5](Tutorial-05-Deploy-Free) | `docker --version` |
| Postgres | never, locally | — |

## Scaffold

```bash
cd $(mktemp -d)
bunx create-ultimate@1.1.0 myapp
```

```text
  99 files in /tmp/tmp.XXXXXXXX/myapp
✓ created myapp — next: cd myapp && x dev
```

```bash
cd myapp && bun install
```

`x` is a workspace dependency, not a global install. `bunx x <command>` resolves `node_modules/.bin/x`; the `package.json` scripts (`bun run verify`, `bun run dev`) resolve the same binary.

### Two shapes, one generator

| Invocation | Files | `x verify` on run one |
|---|---|---|
| `bunx create-ultimate@1.1.0 myapp` | 99 | 16 of 17 green — `typecheck` fails on two known gaps, [below](#the-one-red-step-on-run-one) |
| `bunx create-ultimate@1.1.0 myapp --no-example` | 76 | **all 17 green** |

`--no-example` omits the `post` feature slice and its route. Pick it when an agent is about to write the real feature anyway — [tutorial 2](Tutorial-02-First-Feature) starts there. Pick the default when you want a worked example to read.

## The gate, first thing

```bash
bunx x verify
```

`--no-example`, verbatim:

```text
  ✓ typecheck          11297ms
  ✓ lint               109ms
  ✓ boundaries         6ms
  ✓ filesize           5ms
  ✓ package-shape      2ms
  ✓ errors             5ms
  ✓ unit               175ms
  - contract           0ms
  - live               0ms
  - job                0ms
  - e2e                0ms
  ✓ eval               31ms
  ✓ drift              2ms
  - contract-diff      0ms
  ✓ budgets            0ms
  ✓ manifest           1ms
  - roadmap            0ms
✓ all 17 steps passed in 11633ms
```

`-` is skipped, not passed: no `*.contract.test.ts` exists yet, so the step has nothing to check. [Tutorial 2](Tutorial-02-First-Feature) turns four of those dashes into ticks.

### The one red step on run one

With the example slice, `typecheck` fails on two pinned errors:

```text
  ✗ typecheck          10586ms
      X_TYPECHECK_FAILED
        cause: the project does not typecheck
        fix:   bunx tsc -b --pretty false
        docs:  https://ultimate.dev/errors/X_TYPECHECK_FAILED
      | apps/web/app/post/entity.ts(22,46): error TS18048: 'c.title' is possibly 'undefined'.
      | apps/web/app/post/entity.ts(23,49): error TS18048: 'c.price' is possibly 'undefined'.
```

`InvariantColumns` is an index signature (`readonly [column: string]: ColumnExpr`) and the app's `tsconfig.json` sets `noUncheckedIndexedAccess: true`, so `c.title` widens to `ColumnExpr | undefined`. It affects `x g resource` and `x g entity` output too, not only the scaffolded example.

Workaround — a non-null assertion on the column reference. Verified green:

```ts
invariants: [
  invariant('post_title_not_blank', (c) => c.title!.trimmed().minLength(1)),
  invariant('post_price_non_negative', (c) => c.price!.minor.atLeast(0)),
],
```

Tracked in [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md) under 1.1.0's known gaps. Everything else that shipped broken: [Known gaps](Known-Gaps).

## Run it

```bash
bunx x dev
```

`--once` boots, reports and exits — the shape to paste into a smoke test:

```bash
bunx x dev --once --port 3100
```

```text
{"ts":"2026-08-11T17:01:45.774Z","level":"info","msg":"ultimate web listening on http://localhost:3100"}
{"ts":"2026-08-11T17:01:45.783Z","level":"info","msg":"sync node ready","buildId":"d5912e63ac22b7e4","path":"/_x/sync"}
{"ts":"2026-08-11T17:01:45.793Z","level":"info","msg":"jobs.worker.started","workerId":"worker-019ff1c5-…","queues":["default"]}
{"ts":"2026-08-11T17:01:45.793Z","level":"info","msg":"jobs.scheduler.started","tasks":0}
  roles web, sync, worker, scheduler
  panels routes, timeline, live, jobs, db, mail, cache, policy, manifest, services, boundaries
  manifest /tmp/…/myapp/x.manifest.json
  introspect http://localhost:3100/_x
✓ dev ready on http://localhost:3100 — /_x mounted (11 panels), db=embedded events=embedded storage=embedded mail=embedded cdn=none
```

Four roles in one process, isolation simulated rather than skipped. `replicator` is opt-in via `--role`; `migrate` is not a dev role.

### Why no Docker

`.env.development` ships every service key **empty**, and empty means embedded:

```bash
DATABASE_URL=
NATS_URL=
S3_ENDPOINT=
PORT=3000
ROLE=web
```

| Key | Unset means | Set means |
|---|---|---|
| `DATABASE_URL` | PGlite in this process, under `.x/pgdata` | that Postgres |
| `NATS_URL` | in-process fanout | that NATS server |
| `S3_ENDPOINT` | `.x/storage` on disk | that S3 |

Nothing in the framework branches on `if (dev)` — only the driver behind the seam differs. Same code path, same `db()`, same `enqueue()`. Full table: [CLI reference § x dev](CLI-Reference).

## What each directory is

```
myapp/
├── app.config.ts            the one config file — names env KEYS, never values
├── apps/
│   ├── web/
│   │   ├── site/            static, 0kb JS, SEO-critical. May NOT import app/
│   │   ├── app/             authed, streaming, realtime. Feature slices live here
│   │   ├── api/             actions only — no rendering, no components
│   │   ├── shared/          actor type, tokens, primitives. A leaf both surfaces import
│   │   ├── server.ts        the production entry: ROLE + PORT, nothing else
│   │   └── prerender.ts     the static entry: one HTML file per `render: 'static'` route
│   ├── admin/               the admin app, gated on `admin:read`
│   ├── desktop/  mobile/    README stubs, no code
├── packages/
│   ├── db/                  schema.ts (the entity export list) + migrations/
│   ├── domain/              pure types, no I/O
│   ├── i18n/                catalogs/<locale>.json — one flat file per locale
│   ├── mcp/                 the app's own MCP surface over its actions
│   └── ui/                  app components on semantic tokens
├── docker/                  Dockerfile, .dockerignore, dev + prod compose
├── bin/                     setup, dev, check
└── AGENTS.md  CLAUDE.md     the two files an agent reads first
```

Boundaries are a build error, not a note: `bunx x boundaries` runs inside `x verify`. Full model: [Project layout](Project-Layout).

### `bin/setup` is broken at 1.1.0

`bin/setup` calls `bunx x db migrate`, which shells out to `drizzle-kit` — a package a scaffolded app neither installs nor configures. It exits `X_DB_MIGRATE_FAILED`. Skip it; `bun install` plus `bunx x dev` is the whole first run, and [tutorial 2](Tutorial-02-First-Feature#migrations) covers migrations.

## Three standing findings

Every registry command in a fresh scaffold prints the same three. They are **not** `x verify` steps, so the gate stays green while they sit there:

```bash
bunx x routes
```

```text
  X_ROUTE_MODE_INVALID (apps/web/app/posts/page.tsx)
    cause: … declares render: 'stream' but has no <Suspense> boundary, so there is nothing to
           stream — the whole page waits like ssr
  X_ROUTE_MODE_INVALID (apps/web/app/dashboard/page.tsx)
  X_ROUTE_DUPLICATE (apps/admin/app/page.tsx)
    cause: / is claimed by both apps/web/site/page.tsx and apps/admin/app/page.tsx
```

| Finding | Fix that works | Fix that does not |
|---|---|---|
| `X_ROUTE_MODE_INVALID` ×2 | set `render: 'ssr'` in the page **and** in its `page.test.ts`, which pins the mode | adding `<Suspense>`: the pinned `solid-js@2.0.0-experimental.16` does not export it from its server build |
| `X_ROUTE_DUPLICATE` | `mv apps/admin/app/page.tsx apps/admin/app/admin/page.tsx` — the directory is the URL | deleting the site landing page |

After both:

```text
  path        surface  render  hydrate  offline       file
  /           site     static  never    precache      apps/web/site/page.tsx
  /admin      app      spa     idle     network-only  apps/admin/app/admin/page.tsx
  /dashboard  app      ssr     visible  runtime       apps/web/app/dashboard/page.tsx
  /todos      app      ssr     visible  runtime       apps/web/app/todos/page.tsx
✓ 4 routes
```

## The five commands worth memorising

| Want | Command |
|---|---|
| is it shippable | `bunx x verify` (add `--json`) |
| what is wrong with my environment | `bunx x doctor --json` |
| what does this error code mean | `bunx x errors explain X_FORBIDDEN` |
| what does this app contain | `bunx x manifest --json` |
| what commands exist | `bunx x help` — planned ones are marked `(planned)` and throw `X_NOT_IMPLEMENTED` |

## Next

[Tutorial 2 — your first feature](Tutorial-02-First-Feature): one `entity`, one `policy`, one `action`, one `route`, one test, and the five artifacts a single declaration projects.
