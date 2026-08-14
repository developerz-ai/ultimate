# Known gaps

Defects and unfinished seams that shipped **in** 1.1.0, named here rather than left to be discovered. `As of 2026-08`.

A reference manual that hides these is lying to the reader. Source of truth is the *Known gaps* section of [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md); anything below that the changelog does not carry is noted as such.

| Gap | Symptom | Work around it by |
|---|---|---|
| `x build --target binary` | boots `As of 2026-08` — the import crash is fixed — but the target is **unproven end to end**: no scaffolded app has been compiled and served from a bare VM, and the binary is a launcher for an app tree, not a self-contained artifact | `--target docker` when you want one file that carries everything |
| `docker-compose.prod.yml` | declares `ports: ['3000:3000']` on `web` **and** `replicas: 3` — two processes cannot bind one host port, so scaling past 1 fails to start | drop `ports:` and put a reverse proxy in front, or set `replicas: 1`. This is the rung-1 ceiling → [`docs/idea/17-scale-ladder.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/17-scale-ladder.md) |
| Shared cache tier invalidation | the Lua script `DEL`s keys it never declared in `KEYS`, so it fails on **Dragonfly** and on **Redis Cluster** | single-node Redis, or a cache tier that is not the shared one → [Caching and invalidation](Caching-And-Invalidation) |
| `resolveEnvironment` twice | the name exists in both `@ultimat3/core` and `@ultimat3/seo` with different parameters and different return unions | import one with an alias; the table below says which you want → [Configuration](Configuration) |
| Helm cannot reach `/metrics` | every role now serves it on `METRICS_PORT` (9090) and the recorders are wired, but no role in `values.yaml` declares a metrics container port and the chart ships no scrape target — so the HPAs still read `<unknown>` | add `metricsPort: 9090` per role, a second `ports:` entry in `_helpers.tpl`, and a scrape target → [Observability](Observability) |
| `apps/web/shared/tokens.scss` | as scaffolded it reads six SCSS variables `@ultimat3/ui/tokens` does not export (`$surface-base`, `$surface-raised`, `$text-primary`, `$text-secondary`, `$accent-solid`, `$accent-on-solid`); nothing in the scaffold `@use`s the file, so the breakage is latent until you do. **Not in `CHANGELOG.md`'s list** | delete it, or rewrite it over `t.role('surface-raised')` → [Theming](Theming) |
| `x deploy --method helm` | throws `X_NOT_IMPLEMENTED` in a scaffolded app, because `x new` never writes `docker/helm` | copy `docker/helm` from the framework repo, or `--method compose` → [Deployment](Deployment) |
| Planned CLI commands with flags | a planned command's spec declares no flags, so `x env check --fix` fails at the **parser** with `X_CLI_BAD_FLAG` rather than the honest `X_NOT_IMPLEMENTED` | run the flagless form to see the real message → [CLI reference](CLI-Reference) |

## Found while writing the tutorials

Every row below was hit by actually running the command against a 1.1.0 scaffold. **None are in `CHANGELOG.md`'s list.**

| Gap | Symptom | Work around it by |
|---|---|---|
| **`x db gen` / `x db migrate`** | both shell out to `bunx drizzle-kit`, which `x new` neither installs nor configures → `X_DB_GEN_FAILED` / `X_DB_MIGRATE_FAILED` on "drizzle.config.json file does not exist". **This also breaks `bin/setup`, the scaffold's own documented first command** | generate with `generateMigration` + `writeSchemaHash` from `@ultimat3/db` directly, then apply with `ROLE=migrate bun apps/web/server.ts` → [2 · First feature](Tutorial-02-First-Feature) |
| Composite indexes in generated SQL | `indexes: [{ on: ['orgId','createdAt'] }]` emits `on "todos" ("org_id_created_at")` — one mangled name instead of two columns. The SQL will not apply | write the index by hand in the migration file |
| Multi-statement migrations | a migration whose `up` holds two statements fails: `cannot insert multiple commands into a prepared statement` | one statement per migration file |
| `x g task <name>` with no `--feature` | the job it writes imports `../repo` into a brand-new directory that has none → `X_CLI_UNEXPECTED` on load | always pass `--feature <slice>` |
| Jobs and tasks register anonymously | a fresh scaffold has no `apps/web/api/index.ts`, so they register as `anonymous-job-2` / `anonymous-task-1` | add `defineApi` — [4 · Jobs and realtime](Tutorial-04-Jobs-And-Realtime) |
| Generated tests land in the wrong step | `contractTest` / `liveTest` / `jobTest` inside a plain `*.test.ts` run under `unit`, and `x test contract` answers `X_TEST_NO_FILES` | rename to `<name>.contract.test.ts` etc. — the filename is the type |
| Three standing route findings | a fresh scaffold reports `X_ROUTE_MODE_INVALID` ×2 and `X_ROUTE_DUPLICATE` (`apps/admin/app/page.tsx` claims `/` against the site landing page). `x routes` is not a gate step, so `x verify` never sees them | `x routes` after scaffolding, then fix |
| `X_ROUTE_MODE_INVALID`'s fix line is wrong | it says wrap in `<Suspense>`. Solid's `<Suspense>` throws `getContextId cannot be used under non-hydrating context` under this renderer, at any Solid version — the server JSX factory is inert by design and is not a Solid renderer | set `render: 'ssr'` on the route instead. Async data needs no boundary: `renderToHtml` awaits async components and promise children |
| `.env.development` ships in the image | `.dockerignore` excludes `.env` and `.env.*.local`, not `.env.development` | harmless as generated (all values empty, a real env var wins) — but add it to `.dockerignore` before you put anything in it |

## Still open from 1.0.0

| Open | Where it stands |
|---|---|
| Two-platform deploy proof | milestone 11, still 🚧. All three build targets, both compose files and the Helm chart ship; the demo app on Compose **and** K8s from one image with an invisible rolling restart is not yet demonstrated |
| Multi-node realtime | the 50k forced-restart benchmark **is** measured, but on one `sync` node over `InProcessTransport` — it never crossed NATS. Fanout, throughput and per-node socket capacity remain targets → [Realtime](Realtime) |
| `X_MIGRATE_CONCURRENT` | reserved, not thrown — **but the lock is real**. `migrate()` and `rollback()` hold `pg_advisory_lock(MIGRATION_LOCK_KEY)` on one pinned session for the whole run, unless `lock: false` (only `x db branch` passes it), and `ROLE=migrate` does not. Two overlapping deploys serialise: the second **waits**, it does not race and does not error, which is why the code has no throw site. No pipeline serialisation needed |
| Deferred to v2 | realtime tier 3 local-first (`persist: true`), the plugin API, multi-region replication, and the Redis/NATS **job** drivers — each behind an interface that ships today, throwing `X_NOT_IMPLEMENTED` with a runnable `fix:` rather than pretending to work |

Reserved-but-unthrown error codes are listed in full under [Error codes → Reserved codes](Error-Codes#reserved-codes). Symptom-first triage is [Troubleshooting](Troubleshooting).
