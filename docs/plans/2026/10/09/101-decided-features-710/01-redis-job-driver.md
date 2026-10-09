# 01 — Redis job driver (decision 5)

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 3 (+5 for the test).

## Files to change
- `packages/jobs/src/driver-redis.ts` — `redisJobDriver({ client?, prefix?, clock?, doneTtlMs? })` on `Bun.redis`.
- `packages/jobs/src/driver-redis-scripts.ts` — one Lua script per operation: enqueue, claim (with burial), ack, nack, heartbeat, stats, fenced step put.
- `packages/jobs/src/driver-redis-steps.ts` — the `StepStore`, one HASH per run.
- `packages/testing/src/job-driver-conformance-redis.live.test.ts` — `jobDriverConformance` against `TEST_REDIS_URL`.
- `packages/jobs/src/driver-redis.live.test.ts` — one operation script on memory and Redis, every answer compared.
- Docs: `packages/jobs/{README,CLAUDE}.md`, `wiki/Jobs-And-Workflows.md`, `wiki/Known-Gaps.md`, `docs/architecture/08-jobs-internals.md`.

## Steps
1. Every key under one `{prefix}` hash tag (one slot: Cluster/Dragonfly-legal); `KEYS[1]` routes.
2. Mirror `driver-memory.ts` semantics: idempotency namespace `(name, tenant, key)` over live rows, caller-allocated id = published, claim fence `{ workerId, claim }`, lapsed final attempt buried `dead`/`failed`.
3. No `introspect`/`backfills`/`leases` (stated, not stubbed). `done` rows expire after `doneTtlMs`.
4. CI: the `live` gate part already starts `redis` from `docker/docker-compose.test.yml` and exports `TEST_REDIS_URL`.

## Done when
- The conformance suite passes on Redis in CI's `live` part; the parity test fails when a script is mutated.
