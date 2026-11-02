# 29c — Redis down is a slow read, not a hang

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0 (`core`), 1 (`cache`), 3 (`jobs`). **No adopter runs this tier today: five declare `['request-memo', 'lru']`. This is rung-1 work ahead of its first user; sequence it accordingly.**

## Why
`packages/cache/README.md:266` says a dead tier never fails a write, and `cache/src/tiers.ts:241` says a refusing tier is a miss. Nothing bounds a tier that does not answer. Reproduced 2026-11-02 on Redis 7, Bun 1.4.4, the real `redisTier` and `cacheStack`:

| State | `stack.read` |
|---|---|
| up | 7 ms |
| server paused (a lost node, a full network queue) | `HUNG` at 45 s, 0 failures recorded |
| same, `invalidateTags` | `HUNG` at 20 s. It runs on an action's commit path |
| server stopped, default client | first read 30,916 ms, then fast refusals |
| server back, 37 s later, default client | still `ERR_REDIS_CONNECTION_CLOSED: Connection has failed`. **The default client never reconnects after 10 attempts** |

So a Redis restart longer than 31 s kills the shared tier on every pod until each restarts, and a dead pod's busts stop reaching the store the restarted pods read. `redisJobDriver` takes the same `Bun.redis` (`jobs/src/driver-redis.ts:68`): enqueue blocks, then the queue is down for good. The realtime transport already solved this for its own client (`realtime/src/nats-transport.ts:4`). No adopter runs the shared tier yet (five declare `['request-memo', 'lru']`, the operator's stack template provisions `REDIS_URL`); the scale ladder makes it rung 1 (`docs/idea/17-scale-ladder.md:238`).

Design check, same server: client options below, 150 ms tier deadline: paused read 757 ms, stopped read 1 ms, 35 s stopped then restarted: back within 4 s, `connected: true`.

## Decisions
| Question | Answer |
|---|---|
| Which client | `new Bun.RedisClient(url, { enableOfflineQueue: false, maxRetries: 2147483647, connectionTimeout: 1000 })`, `connect()` in the background. A command while down refuses at once, and a miss is what a refused read means |
| Where it lives | `core/src/redis-client.ts`, behind the subpath `@ultimat3/core/redis`, never the barrel: `core` is in every bundle graph and this reads `Bun.RedisClient`, the rule of [`11-core-outbound.md`](11-core-outbound.md). Not a tier rule: `jobs → cache` is legal (3 → 1). `core` because a job driver should not take a new `cache` edge for one client, and `cache` publishes no subpath. `RedisLike`/`RedisSender` stay the seam |
| Deadline | in the tier, per command, default 150 ms. Option `commandTimeoutMs`, screened by `assertFiniteDurationMs` (`cache/src/tiers.ts:131`). A value write-back gets the same |
| 5 commands × 150 ms per read while paused | a miss **parks** the tier's value path for 5 s: commands refuse at once. One clock read, no state machine; `breaker()` stays deferred |
| Parking and busts | `invalidateTags` skips the park and has its own 1,000 ms: a bust skipped for a stall leaves stale rows to TTL. Past it, the existing `errors` entry and retry (`cache/src/redis.ts:191`) |
| The job driver | client only, no deadline. An enqueue that cannot reach the queue must fail typed: `DriverUnavailableError`, immediately, instead of blocking and then dying. A stuck command has the request deadline |
| A stampede on Postgres while Redis is gone | single-flight still holds per pod (`cache/src/tiers.ts:400`); across pods it is the rung's known cost. No new mechanism |

## Files to change
- `core/src/redis-client.ts` (new), `core/package.json:22` (`./redis`) — `redisClient(url?)`: reads `REDIS_URL`, one per process per URL. `/** why */` on each option: this file is the measured record. Not in `core/src/index.ts`.
- `cache/src/redis.ts:135,209` — `resolveClient` builds on it, not `Bun.redis`; `conn()` wraps with deadline and park. `:358` the bust path bypasses the park.
- `cache/src/redis-deadline.ts` (new) — `withinDeadline(client, { commandTimeoutMs, parkMs, clock })`, so `redis.ts` (418 lines) does not grow.
- `cache/src/errors.ts` — no new class; the refusal is `CacheDriverUnavailableError`, which `bestEffort` records.
- `jobs/src/driver-redis.ts:68` — same `redisClient`; maps `ERR_REDIS_CONNECTION_CLOSED` to `DriverUnavailableError`.
- `packages/cache/README.md:266`, `wiki/Caching-And-Invalidation.md` (a Redis-down row), `docs/ops/06-runbooks.md`, `packages/jobs/README.md`, `packages/core/README.md`, the three `CLAUDE.md`s.
- Stale, same diff: `docs/idea/05-caching.md:16,124` still say keys carry no scope, `query/src/cache.ts:47` ships `scope` defaulting to `actor`; `:108` says one `EVAL` deletes members, `cache/src/redis.ts:76` explains why not. `docs/ops/05-disaster-recovery.md:129`: a restore leaves the live shared tier holding values newer than the restored rows, so restore with a new `APP_VERSION` (`cache/src/redis.ts:56`) or flush that index.

## Steps
1. `redisClient` with its options; a live test before anything else depends on it.
2. `withinDeadline`, unit against a fake that never settles.
3. Wire `redisTier`; `bestEffort` needs no change.
4. Bust path.
5. Job driver and its mapping.
6. Docs.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_CACHE_DRIVER_UNAVAILABLE` (existing) | recorded in `recentTierFailures`: the tier missed its deadline or is parked | existing, cause names the elapsed time |
| `X_DRIVER_UNAVAILABLE` (existing, `jobs/src/errors.ts:332`) | enqueue or claim while Redis is unreachable | existing |

No new code.

## Tests
- `cache/src/redis-deadline.test.ts`: a never-settling `get` answers a miss inside the deadline; the next command refuses without touching the client; after `parkMs` it does touch it; a bust is not parked. Mutation: remove the park and the call count fails.
- `cache/src/tier-failures.test.ts` extended: a hung tier's read returns the load and records one failure.
- `core/src/redis-client.live.test.ts` and `cache/src/redis.live.test.ts`: disconnect through `CLIENT KILL` on `TEST_REDIS_URL`, commands refuse fast, then answer. Never stops the shared service.
- `core/src/redis-subpath.test.ts`: the barrel exports no `redisClient`.
- `jobs/src/driver-redis.test.ts`: the mapped error.
- `set -a; . docker/test-services.env; set +a; bun test packages/cache/src/redis.live.test.ts packages/core/src/redis-client.live.test.ts`

## Semver
**Breaking, one row**, the same class as [`29-data-pg-unanswered.md`](29-data-pg-unanswered.md): a call that waited now refuses.
Upgrading: "`Bun.redis` is no longer the cache tier's or the job driver's client. While Redis is down a cache read is a miss at once, and `enqueue` is `X_DRIVER_UNAVAILABLE` instead of waiting: catch it where a queued retry was implied. A `client` handed in keeps its own behaviour, and still gets the deadline."

## Done when
- The paused probe answers under 1 s on the first read and under 5 ms for the next 5 s; the stopped-then-restarted probe recovers with no pod restart.
- `bun run verify` green; `bun run scripts/reference-app-gate.ts` unchanged.
