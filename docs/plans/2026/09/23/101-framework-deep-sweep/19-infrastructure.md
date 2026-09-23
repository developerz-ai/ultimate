# 19 — the deployed demo's stack

> Part of [`overview.md`](overview.md). Depends on: 06 n/o/p, 12 j/k, 13 b/d, 16 i/j.
> **Edited from `../infrastructure`, in its own repo, under its own CLAUDE.md and PR flow. Never from this checkout.**
> Paths below are relative to `../infrastructure`: `stacks/apps/ultimate-social/` and `stacks/stateful/postgres-instance/`.

Rule: the stack runs every role the app's declarations need, and its probes, grace and env match
what the framework does at the version it deploys. A comment in the stack that works around a
framework gap is a framework row in slices 06/12/13/16, not a permanent fixture.

Audited read-only on 2026-09-23 against framework 21.0.0. Nothing live was queried: the live
`wal_level`, the image uid and pod RSS are unverified and marked (suspected).

## Files to change

| # | Defect | Path | Change |
|---|---|---|---|
| a | **realtime is dead in production.** The app declares live queries and channels. No `sync` Deployment exists, and the IngressRoute routes only port 3000, so `/_x/sync` gets a 404 from web. The README's own condition for adding sync ("when the app declares live queries") is met | `manifests/` (no sync), `manifests/ingressroute.yml:198-206`, `README.md:38-56` | Add a `sync` Deployment (`ROLE=sync`, `PORT=3000` app, `containerPort` 3001, probes on 3001), its Service, and an IngressRoute rule `PathPrefix(/_x/sync)` with no rate-limit middleware. Add NATS (the cluster's shared NATS) with `NATS_URL` on every realtime role, and a `replicator` Deployment at `replicas: 1`, strategy `Recreate`. Needs row h first |
| b | no `lifecycle.preStop` and no `terminationGracePeriodSeconds` (default 30 s against a 25 s drain), so a rollout drops requests while endpoints propagate | `manifests/deployment-{web,worker,scheduler}.yml` (web `:227-306`) | `preStop: { sleep: { seconds: 5 } }` (the cluster supports the sleep action) and `terminationGracePeriodSeconds: 45`. After framework 01 f ships, the sleep can drop to the framework's readiness grace |
| c | no `startupProbe`, while boot compiles islands before any socket opens | all Deployments | `startupProbe` (`failureThreshold: 30`, `periodSeconds: 5`) on the probe each role already has |
| d | `TRUSTED_PROXY_HOPS` is unset behind Traefik, so the client IP is Traefik's, HSTS is never sent (`x-forwarded-proto` is ignored), and per-IP limits are shared by every visitor | `manifests/configmap.yml:22-34` | `TRUSTED_PROXY_HOPS: "1"` |
| e | `APP_URL` unset (falls back to localhost); hCaptcha keys unset on a public, writable demo, so the null verifier is in use | `manifests/configmap.yml`, `manifests/sealed-secret.yml` | Set `APP_URL` to the demo's public https URL. Seal `HCAPTCHA_SITE_KEY`/`HCAPTCHA_SECRET`. Framework 16 i then makes both required |
| f | comments claim an app-version migration fence, but `APP_VERSION` is unset, so `runMigrations` skips it (framework `packages/cli/src/serve.ts:228`) | `manifests/deployment-web.yml:166,170`, `README.md:156` | Set `APP_VERSION` from the image tag (the `sha-<7>` the image updater writes), or correct the comments |
| g | stale comments and README: "EVERY role serves /healthz" (only web and sync do); the worker docs claim a disagreement the docs no longer have; "not serving yet", "why no scheduler", `/app/.x` vs the real `/repo/dummy/social-media-clone/.x` | `manifests/deployment-web.yml:277-283`, `manifests/deployment-worker.yml:6-8`, `README.md:8-22,38-64,71,101-117,202-213`, `manifests/configmap.yml:42` | Rewrite against framework 21.0.0 |
| h | Postgres is not ready for a replicator: `wal_level` is implicit (suspected `logical` by operator default), there is no `max_slot_wal_keep_size` (an abandoned slot holds WAL without bound on a shared cluster), and the app role has no `replication: true` and no `connectionLimit` | `stacks/stateful/postgres-instance/manifests/cluster.yml:43-57,252-257` | `wal_level: logical` made explicit, `max_slot_wal_keep_size: 2GB`, `replication: true` and `connectionLimit: 80` on the managed role. Create a per-table publication by app migration (framework 06 p gives the exact statement) |
| i | uid 1000 was verified against `oven/bun:1.3-alpine`, but the image is built `FROM oven/bun:1.4-alpine` (framework `Dockerfile.monorepo:24,31`) | `manifests/deployment-web.yml:81-85`, `README.md:110-117` | Re-verify with `docker run --rm oven/bun:1.4-alpine id bun` and update the proof and digest |
| j | scheduler `limits.memory: 256Mi`, with no measurement, for a role that boots the full CLI graph and compiles islands (suspected OOM risk) | `manifests/deployment-scheduler.yml` | Measure boot RSS and set limit = measured × 1.5, or lower it after framework 12 e/k land |
| k | web `replicas: 1` and no PodDisruptionBudget, so a node drain is an outage | `manifests/deployment-web.yml` | Acceptable for a demo: state it in the README. Revisit when 13 j's rollout proof lands |

Matches, no change needed: the `sha-<7>` tag contract (workflow `:75,133-137` ↔ `application.yml` `allow-tags`), ServiceMonitor port name and path, `ROLE` per Deployment, `NODE_ENV=production`, sealed secrets (no dev secret in use), migrate as ordered initContainers, and the scheduler at 1 replica with `Recreate`.

Connection budget, for row h's `connectionLimit`, from framework `packages/db/src/pool-profile.ts`:

| Role | Pool | Replicas | Worst case |
|---|---|---|---|
| web | 20 | 1 (2 in surge) | 40 |
| worker | 8 | 1 | 8 |
| scheduler | 2 | 1 | 2 |
| migrate | 1 | 1 (2 in surge) | 2 |
| sync (row a) | 10 | 1 | 10 |
| replicator (row a) | 4 | 1 | 4 |
| **total** | | | **66** |

## Steps
1. b, c, d, f, g, i. These are safe now, one infra PR.
2. e: seal the hCaptcha keys. Coordinate with framework 16 i.
3. h, then a, after framework 06 n/o/p ship in a release the image picks up. Verify with a two-tab smoke test: a like in one tab appears in the other.
4. j, k.

## Tests
- The infra repo's own checks (see its CLAUDE.md: kustomize build, policy/lint jobs).
- After a: open the demo in two browsers; a live update crosses. `channel_frames_dropped_total` and `channel_replay_gaps_total` appear in the ServiceMonitor scrape.

## Done when
- `/_x/sync` upgrades to a WebSocket on the public host, and a write in one tab reaches another.
- A `kubectl rollout restart` of web under a load loop shows 0 non-2xx.
- The README describes the stack as deployed.
