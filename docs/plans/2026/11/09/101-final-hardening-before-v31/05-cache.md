# 05 — Cache: Redis tag sets that stay bounded, tier parity

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 1 (`cache`).

## Findings
| # | Sev | Site | Failure | Fix |
|---|---|---|---|---|
| R1 | **High** | `cache/src/redis.ts:135` (`TAG_MEMBER_SCRIPT`), `:334` (`set`) | every `set` adds the key to its tag and entity sets and extends their expiry; only `invalidateTags` (`:423`, the sole `SREM`) removes members. An entity written constantly and never invalidated collects dead keys forever; its first invalidation then `SMEMBERS` millions — the outage the header at `:124-127` claims to prevent | sorted sets scored by the value's expiry: the script `ZADD`s the key and `ZREMRANGEBYSCORE -inf now` first, so a set holds live keys only; invalidation reads `ZRANGEBYSCORE now +inf`. New key segment (`t2:`/`e2:`) so a rolling deploy needs no migration; old `t:`/`e:` sets expire on their own TTL |
| R2 | Med | `cache/src/redis.ts:334` vs `lru.ts:157-160` | LRU refuses a value over `maxBytes` (`X_CACHE_TOO_LARGE`); Redis has no cap, so the same `set` pushes multi-MB values that block the shared Redis | `redisTier({ maxValueBytes })`, default 1 MiB, checked on the encoded text, same code |
| R3 | Med | `cache/src/redis.ts:376-428` (`invalidateTags`) | whole tag set returned in one script call (blocks Redis); one `DEL` per key in 128-batches; cleanup awaited per tag per set per batch: ~3,000 sequential round trips for 100k keys on the post-commit path | page with `ZRANGEBYSCORE … LIMIT` (after R1), `UNLINK` not `DEL`, per-set cleanup concurrent (bounded, 8) |
| R4 | Low | `cache/src/redis.ts` (436 lines) | one file: tier, two scripts, layout, sweep | split layout + scripts into `redis-buckets.ts` while doing R1 |

## Files to change
- `packages/cache/src/redis.ts`, `redis-buckets.ts` (new), `redis-fence.ts` (key segment) — R1, R3, R4.
- `packages/cache/src/redis-fake-fixture.ts` — add `ZADD`, `ZREMRANGEBYSCORE`, `ZRANGEBYSCORE`, `UNLINK`.
- `packages/cache/src/redis.ts` options + `packages/cache/README.md` — R2.

## Tests
- `redis-tag-bound.test.ts` (new, fake redis): 10k distinct keys, 1 s TTL, one entity; advance 2 s; one more write → set holds 1 member.
- `tier-parity.test.ts`: an oversized value is refused by both tiers with `X_CACHE_TOO_LARGE`.
- `redis-invalidate.test.ts`: bust of 10k members completes in ≤ 100 sequential awaits.
- Live: `cache/src/*.live.test.ts` against real Redis (CI `gate (live)`).

## Done when
- No unbounded set growth under write-only load (the bound test), and the live suite is green on real Redis.
