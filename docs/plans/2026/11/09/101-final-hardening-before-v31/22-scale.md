# 22 — Scale: big apps boot fast, replicas stay consistent, every rung has a number

> Part of [`overview.md`](overview.md). Depends on: [`07`](07-entity.md) (tenant index), [`13`](13-realtime.md) (fan-out index). Tier: 5 (`cli`), 2 (`entity`, partitioning), `scripts/bench`, docs.

## Measured 2026-11-09
Synthetic apps: small = `examples/dummy` copy (17 entities, 45 actions, 14 queries, 473 TS files); large = + 150 generated resources (167 entities, 346 actions, 164 queries, 180 jobs, 218 routes, 160 islands, 5,073 TS files). No real Postgres; one 12-core box.

| Metric | Small | Large | Growth |
|---|---|---|---|
| `x dev` cold boot to first 200 | 7.1 s / 608 MB | **29.4 s** / 837 MB | 4.2× |
| …loading app modules | 4.6 s | **26.2 s** | ~5 ms/file, serial |
| `tsc` | 4.5 s / 1.36 GB | 10.4 s / 2.4 GB | 2.3× |
| `x build --target static` | 11.1 s / 1.3 MB out | 27.6 s / 11 MB out (10 MB islands) | 2.5× |
| `x.manifest.json` / `openapi.json` | 204 KB / 267 KB | 1.30 MB / 2.16 MB | linear |
| route match, 501 → 50,001 routes | 3.1 µs | 5.2 µs | flat |
| verify subset (11 steps) | 13.9 s | 27.6 s | `drift` flat 8 s; the rest ≤ linear |

Nothing grows super-linearly. Fixed costs dominate.

## Findings — big apps
| # | Sev | Site | Fix |
|---|---|---|---|
| B1 | **High** | `cli/src/app-load.ts:207-231` (`scanAppModules`): serial `await import()`; dev also reads each file's text. Production boots through the same scan (`:260`), so pod start and rollout grow with the app (projected ~60 s at 12k files) | import concurrently (`Promise.all`), register in sorted order (deterministic). **v31:** `x build` writes a prebuilt registry; production boots from it, never scans |
| B2 | Med | no affected-only verify (`cmd-verify-spec.ts`; `x affected` is per workspace) | `x verify --changed`: map changed files to the steps whose inputs they touch (registries → contract/policy/i18n; entities → drift) |
| B3 | Low | `drift` step: fixed ~8 s (PGlite boot + migration replay) | skip when no entity/migration changed (with B2), or reuse a cached template database |
| B4 | Med | static `islands/`, As of 2026-11-09: one shared framework chunk is **falsified** — one global chunk carries the union of what any island uses (examples/dummy 183,281 B, docs-site 46,924 B; `/pricing` 25,557 → ~185 KB). Two shared files already exist: opt-in `islands.sharedChunks` (`cli/src/island-bundle.ts`) and the hashed `page-runtime.<id>.js` (63,928 B, the plan's "63 KB"). Only `/posts/[id]` renders 3 framework-heavy islands; split mode there 96,250 → 70,462 B, but +910…+9,154 B on six single-island routes. No preload: an entry's shared chunks were fetched only after it parsed | **per-route island grouping and modulepreload.** Shipped: `<link rel="modulepreload">` for each rendered `idle`/held island's imports, deduped, the runtime chunk skipped on a booted document, none on a no-island page (`cli/src/route-islands-preload.ts`); JS bytes unchanged (budgets weigh scripts and entries, never `<link>`). Not built, design: the static export knows which islands each route rendered → build islands that co-render on a route in ONE split build, every other island solo. Cost: two-pass export (render, group, rebuild, re-render: island URLs are in the documents), dynamic routes' sets vary by params, the container has no render pass to learn sets from (needs the export's grouping in the image), the layout's `update-banner` co-renders with every app/ island and must be kept out of grouping. Benefit, measured: `/posts/[id]` −25,788 B, every other route unchanged |
| B5 | Low | `x g` loads the whole app per call (1.6 s → 4.0 s) | skip the app load when the generator's checks do not need it |

## Monorepo layout (owner, 2026-11-09: a powerful layout to build anything web) — audit first, then fix
Not audited by the 2026-11-09 sweep. The executor starts this part with a `dx-auditor` run on a scaffold grown to 3 apps (web, admin, api) and 2 shared packages (domain, ui), then turns each finding into a fixed row with a test.

| # | Question | Expected answer, enforced |
|---|---|---|
| M1 | `x g app <name>` / `x g package <name>`: does a second app or shared package scaffold, wire into the workspace and gate green with one command? | yes; scaffold-smoke gains a multi-app shape |
| M2 | Are imports between app and shared packages bounded (app → package only, packages never import apps, `site/` never `app/`) by a build error? | yes, the `boundaries` step on app workspaces |
| M3 | Does `x verify --changed` (B2) and `x affected` gate only the touched workspaces in a multi-app repo? | yes; timed on the 3-app scaffold |
| M4 | Can one deploy image serve several apps by `ROLE`/app, or each app ship its own image, with shared migrations owned once? | one documented answer in `wiki/`, refused otherwise by a coded error |

## Findings — horizontal scale (`docs/idea/17-scale-ladder.md`)
| Claim | Verdict | Fix / benchmark |
|---|---|---|
| Stateless web: rate limits, auth limiter, TOTP replay, idempotency, outbox, event bus, sessions | holds (`cli/src/role-start.ts:147-197`, `runtime-services.ts:394-402`, `runtime-queue.ts:171-222`) | Redis rate-limit store ([`08`](08-http.md) H3) for the write hot spot |
| **Cache/ISR invalidation across replicas** | **gap**: published on the realtime transport (`cli/src/runtime-cache.ts:208,283`); without NATS that is in-process, so rung 1 (roles split, Redis, no NATS) with 2+ web replicas serves stale pages and `cache:` reads until TTL. `warnUnnamed` (`:168`) checks Redis and CDN only. Old pods during a rollout likewise | carry invalidations over Redis pub/sub when `REDIS_URL` is set and NATS is not; otherwise refuse at boot (coded) outside development when `lru` or a purging ISR route is configured with replicas > 1. Update rung 1 text |
| Scheduler single leader | holds (lease row, TTL 30 s); failover **unproven** | live test: kill the leader mid-tick → no double fire, no skip |
| Worker throughput vs nodes | **unproven** | bench: claims/s at 1, 4, 16 workers |
| Realtime cross-node fan-out | holds when NATS configured; **unproven** under load | bench: fan-out latency at 10k subscribers across 3 sync nodes (after [`13`](13-realtime.md) R1) |
| Read replicas + read-your-writes | **holds**; the ladder doc is stale (rung table line ~139 says "nothing opens one yet"; `cli/src/runtime-replica.ts`, `db/src/replica-position.ts:71` do) | fix the doc |
| Pooler (transaction mode) | holds (`db/src/pooler.ts:13`, `prepare: false`, migrate/replicator refused under it) | — |
| **Partitioning** | **gap**: migrations tolerate partitions (`db/src/app-relation.ts:30`); an entity cannot declare one, and an id-only PK conflicts with Postgres' rule that the partition key be in the PK | **v31:** `entity(…, { partitionBy: { column, interval } })`, composite PK, generated partitions, retention dropping whole partitions |
| Zero-downtime deploys | holds (retained assets, SW skew flag, start-first, `not valid` constraints, concurrent indexes); rollout time grows with B1 | B1 |
| Production req/s | **unproven** (only `x dev`: 267 req/s `/`, 183 req/s typed query) | bench `http-hello` on the `--target docker` image, 1 and 3 web pods |

## Files to change
- `packages/cli/src/app-load.ts`, `build-*.ts` (prebuilt registry), `role-start.ts` / `serve*.ts` (boot from it) — B1.
- `packages/cli/src/cmd-verify-spec.ts`, `verify-changed.ts` (new) — B2, B3.
- `packages/cli/src/build-islands*.ts` (shared chunk) — B4. `cli/src/cmd-g*.ts` — B5.
- `packages/cli/src/runtime-cache.ts`, `packages/cache/src/redis-pubsub.ts` (new) — invalidation.
- `packages/entity/src/partition.ts` (new), `describe.ts`, `packages/db/src/generate.ts` (partition DDL) — partitioning.
- `scripts/bench/{boot-vs-files,worker-throughput,fanout-3-nodes,http-prod-image}.bench.ts` + `scripts/bench/results/` + `scripts/bench-claims.ts` rows.
- `docs/idea/17-scale-ladder.md` — replicas row, rung 1 invalidation, each rung's measured number.

## Tests
- `app-load.test.ts`: registration order identical serial vs concurrent (snapshot of the registry).
- `runtime-cache.test.ts`: two app instances on one Redis, no NATS: a write on A invalidates B.
- `partition.live.test.ts`: monthly partitions created; insert routes; retention drops a partition.
- Benches in `bench.yml` (weekly), with claims held by `bench-claims.ts`.

## Done when
- Large synthetic app (5k files): dev boot < 10 s; production pod boot from the prebuilt registry < 3 s.
- Every rung in `17-scale-ladder.md` cites a committed measurement.
