# @ultimat3/http — rate limiting, the full rules

Moved out of [`packages/http/CLAUDE.md`](../../packages/http/CLAUDE.md) (plan 101 slice 21,
`As of 2026-11-09`), where a one-line summary of each stays. Where the two disagree, that file wins.

## The rules as they stood before 31.0.0

- **An address key is core's `addressNetwork(ip)`**: IPv4 whole, IPv6 its `/64` (v31).
- **One request spends a LIST of keys**: the caller's and, when `rateLimit.tenantBucket` is declared,
  `tenant|org:<id>` (not route-scoped); stop at the first refusal; an undeclared name is
  `X_RATE_LIMIT_TENANT_BUCKET_UNKNOWN`. Headers report the bucket closest to refusing.
- **The memory store is bounded** (`forgetAtMs` sweep, `DEFAULT_MAX_RATE_LIMIT_KEYS`, evicting the
  entries closest to FULL first — never LRU).
- **The limiter takes a `Clock`** (`rateLimiter({ clock })`); `deps.limiter` is the one seam.
- **The scope is DECLARED, with no default**: an enabled limiter without `scope` is
  `X_RATE_LIMIT_SCOPE_UNSET`; `assertRateLimitScope` (in `httpPipeline`) refuses `'shared'` over a
  per-process store (`X_RATE_LIMIT_NOT_SHARED`). (31.0.0: see below.)
- **A failed `auth: 'required'` is metered in the `auth` stage**. Full rule: `docs/history/http.md`.
- **`redisRateLimitStore({ client })`**: one Lua bucket, tokens as a string, expires at full; degrades as Postgres does (+ `ERR_REDIS_CONNECTION_CLOSED`). `rate-limit-redis.live.test.ts`.
- **`postgresRateLimitStore({ executor })` is the shared store**, over `@ultimat3/core`'s structural
  `PgExecutor` (re-exported here). The
  refill expression is repeated inside `on conflict do update` on purpose; `spent` is a stored column;
  `purgeExpired(nowMs)` takes the caller's clock.
- **A bucket a route names must be registered**: `withRouteBuckets` merges `meta.rateLimitBucket`
  into the table in `httpServer` and `httpPipeline`; any disagreement is
  `X_RATE_LIMIT_BUCKET_CONFLICT`. **The installed limiter must hold it too** — `RateLimiter.buckets`
  is declared and `assertRouteBuckets` refuses, never rebinds.

## 31.0.0 — one slot, chosen in `runtime.ts`

- `httpServer({ rateLimitStore })` is gone. The server's limiter counts in the INSTALLED store
  (`liveRateLimitStore`, the slot read on every request, so a store installed after the server was built is honoured) — the same slot actions and
  queries spend their declared `rateLimit:` from. Before, the boot had to hand the same instance
  to `httpServer` AND install it for the primitives, and a server handed a different store while
  the boot had already chosen one was a second answer (`keepChosen` existed to paper over it).
- `installRateLimitStore` is exported from `@ultimat3/http/adapter` only, and returns the undo
  that removes its own frame (the old `adoptRateLimitStore` semantics; `adoptRateLimitStore` is
  deleted). The boot calls it with `runtime.rateLimitStore` or `postgresRateLimitStore` over the
  pool it opened; an app never calls it.
- `resetRateLimitStore` moved with it to `@ultimat3/http/adapter` (coordinator ruling: every
  installer and reset of a port lives on `./adapter`, never `.`).
- `clearDefaultRateLimitBuckets()` (also `@ultimat3/http/adapter`) is the per-test reset: it empties
  the default memory store and leaves every installed store in place, so a suite that installed a
  shared store in `beforeAll` keeps running on it. `resetRateLimitStore` drops the installed stack too.
