# Tutorial 1 — your first app

One command scaffolds a monorepo that already runs. No Docker daemon, no database to provision, no `.env` to fill in.

`As of 2026-08`. **This page documents `main`, not a published release.** Every file count, gate result and command output below was re-measured on this tree: `x new` → `bun install` → the command, in a directory outside the checkout. Rows that still describe a published version say so in their own line.

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
bunx create-ultimate myapp
```

**Unpinned on purpose.** Pinning the tutorial to a version pins readers to a scaffold that stops matching this page on the next tag; `README.md` and `llms.txt` drop the pin for the same reason. To reproduce a specific release, add `@<version>` and read that release's tag of this page.

```text
  125 files in /tmp/tmp.XXXXXXXX/myapp
✓ created myapp — next: cd myapp && bun install && x db gen "initial" && x db migrate && x dev
```

Counts are a derived fact — `x new --dry-run --json` lists every file, and one added template moves the number.

```bash
cd myapp && bun install
```

`x` is a workspace dependency, not a global install. `bunx x <command>` resolves `node_modules/.bin/x`; the `package.json` scripts (`bun run verify`, `bun run dev`) resolve the same binary.

### Two shapes, one generator

Measured on `main`, `As of 2026-08`, `x new --dry-run --json | jq '.data.files | length'`:

| Invocation | Files | `x verify` on run one |
|---|---|---|
| `bunx create-ultimate myapp` | 115 | 11 pass, **1 fails**, 5 skipped — the red step is `budgets`, [below](#the-one-red-step-on-run-one) |
| `bunx create-ultimate myapp --no-example` | 91 | 10 pass, **1 fails**, 6 skipped — the same red step, one fewer route |

`--no-example` omits the `post` feature slice and its route. Pick it when an agent is about to write the real feature anyway — [tutorial 2](Tutorial-02-First-Feature) starts there. Pick the default when you want a worked example to read.

## The gate, first thing

```bash
bunx x verify
```

`--no-example`, verbatim, on `main` `As of 2026-08`:

```text
  ✓ typecheck          19642ms
  ✓ lint               359ms
  ✓ boundaries         124ms
  ✓ filesize           80ms
  ✓ package-shape      28ms
  ✓ errors             86ms
  ✓ unit               2046ms  8 workers
  - contract           0ms
  - live               0ms
  - job                0ms
  - e2e                0ms
  ✓ eval               2907ms
  ✓ drift              18ms
  - contract-diff      0ms
  ✗ budgets            120ms
  ✓ manifest           63ms
  - roadmap            0ms
✗ 1 of 17 steps failed — 6 skipped: contract, live, job, e2e, contract-diff, roadmap
```

`-` is skipped, not passed: no `*.contract.test.ts` exists yet, so the step has nothing to check. The summary counts the two apart and names every skip, so a gate that is green because a suite does not exist says so on the one line you read. [Tutorial 2](Tutorial-02-First-Feature) turns three of those dashes into ticks.

Timings are one Linux laptop, not a benchmark.

### The one red step on run one

`budgets`, one finding per route with a declared budget:

```text
  ✗ budgets            120ms
      X_BUDGET_UNMEASURED (/)
        cause: / declares a JS and LCP budget and no build has written .x/build-stats.json in this repo
        fix:   x build --target static --json && x verify --json
```

Three routes with `--no-example` (`/`, `/admin`, `/dashboard`), four with the example slice (plus `/posts`).

**Not a scaffold defect, and no template change closes it.** Every generated route declares a `budget:`, and the `budgets` step reads its measurement out of `.x/build-stats.json` — a file only `x build --target static` writes, through `apps/web/prerender.ts`. A bare `x build` defaults to `docker` and writes no stats. So on a fresh app every budget is unmeasured. Run the step's own `fix:` once and it goes green; closing it permanently is a change to the step, not to the scaffold. It is the one red step the framework's own `scaffold-smoke` CI job allows (`--allow-red budgets`), and that list may never grow.

### The invariant block is typed from your columns

`invariants` is one callback over the whole list, and `c` is typed from the `columns` above it:

```ts
invariants: (c) => [
  invariant('post_title_not_blank', c.title.trimmed().minLength(1)),
  invariant('post_price_non_negative', c.price.minor.atLeast(0)),
],
```

`c.titel` is a compile error that names `title`, not a runtime surprise. Everything `x new` and `x g` write typechecks as generated — no `!`, no edit before the first `x verify`.

What still ships broken: [Known gaps](Known-Gaps).

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

Boundaries are a build error, not a note — but `boundaries` is a **step of `x verify`**, not a top-level command. `bunx x boundaries` exits `X_CLI_UNKNOWN_COMMAND`. Run `bunx x verify` and read the `boundaries` line. Full model: [Project layout](Project-Layout).

### The database, first run

`packages/db/migrations` starts **empty**, and `x db gen` is its only writer. Two commands, in this order:

```bash
bunx x db gen "initial"    # entities → <id>.sql, <id>.snapshot.json, <id>.hash
bunx x db migrate          # applies them, then diffs the live schema against the ledger it wrote
```

`bin/setup` runs both — `bun install`, `x db gen "initial"` when the directory holds no `.sql`, `x db migrate`, then the seed. `x db migrate` is `@ultimat3/db`'s own migrator, the one `ROLE=migrate` runs, so nothing extra has to be installed.

Until the generate has run, `x verify` is **red on its `drift` step** — correct behaviour with a runnable fix, not a defect:

```text
X_DB_DRIFT: schema differs from migrations
  cause: packages/db has a schema but no migration recorded it
  fix:   x db gen "initial"
```

That is the scaffold **with** the example slice, which declares one entity. `x new --no-example` declares none, and zero entities against zero migrations is agreement rather than drift, so its `drift` step is green from the first run and goes red the moment you write your first `entity()`.

`x new` hand-wrote a `0000_initial.sql` until 2026-08 and that was the defect — a second writer of a directory the generator owns, whose file carried no `.snapshot.json`, so `x db migrate` answered `X_DB_DRIFT` naming `x db gen` and `x db gen` answered `X_MIGRATION_SNAPSHOT_MISSING` naming version control for a file version control never had. Neither `fix:` now names the command that raises the other ([Known gaps](Known-Gaps)).

## The routes are clean

`x routes` on a fresh scaffold reports four routes and no findings — the scaffold writes `apps/admin/app/admin/page.tsx` rather than claiming `/` twice, and no page declares `render: 'stream'` without a boundary:

```bash
bunx x routes
```

```text
  path        surface  render  hydrate  offline       file
  /           site     static  never    precache      apps/web/site/page.tsx
  /admin      app      spa     idle     network-only  apps/admin/app/admin/page.tsx
  /dashboard  app      ssr     visible  runtime       apps/web/app/dashboard/page.tsx
  /posts      app      ssr     visible  runtime       apps/web/app/posts/page.tsx
✓ 4 routes
```

`--no-example` drops `/posts` and reports three. `x routes` is not a gate step either way, so a finding here never fails `x verify` — run it after scaffolding and after every `x g route`.

If you do hit `X_ROUTE_MODE_INVALID` on a page you wrote, its `fix:` offers two edits and only the second works: set `render: 'ssr'`. Solid's `<Suspense>` throws under this renderer at any version, and async data needs no boundary — `await` it in the component ([Known gaps](Known-Gaps)).

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
