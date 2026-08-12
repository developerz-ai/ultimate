# 01 — Bugs: tiers 0–2

> Part of [`overview.md`](overview.md). Depends on: none. Tiers: 0–2.

Fix in severity order. Every new failure mode gets a registered `X_*` code with a runnable `fix:`
(see `packages/db/src/errors.ts:11-44` for the pattern), a row in `wiki/Error-Codes.md`, and
`bun run manifest` after.

## Critical

- `packages/db/src/transaction.ts:111` — `BEGIN` executes outside the `try` whose `finally` releases the reserved connection (`:121-123`); a failed BEGIN leaks the connection, and on PGlite wedges the single-session turn queue (`packages/db/src/pglite.ts:167`) for the process lifetime. Minimal fix: move reserve+BEGIN inside the guarded scope, mirroring `packages/db/src/readonly-query.ts:90-127` (the correct shape). [`06-raii.md`](06-raii.md) then converts both to `await using`.
- `packages/db/src/migrate.ts:143-149` — `pg_advisory_lock` issued on the pool, so the lock lands on an arbitrary pooled connection: two migrators can run concurrently and the unlock at `:148` can hit a third connection (returns `false`, swallowed). Fix: reserve one session, take the lock, run the migration tx, unlock on the same session. `rollback()` (`migrate.ts:202`) takes no lock at all — give it the same.
- `packages/cache/src/tiers.ts:81-93` — after `load()` succeeds, unguarded `tier.set()` loops fail the business read when a tier refuses the write (`LruCache.set` throws `X_CACHE_TOO_LARGE`, `packages/cache/src/lru.ts:115-117`). Route tier failures into `report.errors` as `packages/cache/src/invalidate.ts:108-116` already does — the package's own stated rule.

## High

- `packages/storage/src/signed-url.ts:143` — `decodeURIComponent` in `parseConstraints` throws a bare `URIError` on `%ZZ`; header claims "Verification never throws". Catch → `'malformed'` (already a `SIGNED_URL_FAILURES` member). Copy `packages/auth/src/session.ts:243` (`decodeCookieValue`).
- `packages/http/src/router.ts:186,191` — unguarded `decodeURIComponent` on params/wildcards; a client typo becomes `X_INTERNAL` → 500 → error-monitor page (`packages/http/src/pipeline.ts:306`). Catch → coded 400.
- `packages/seo/src/rss.ts:52-54` — unparseable `published` → `new Date(NaN).toISOString()` throws `RangeError`; `Math.max(...times)` spread overflows on large feeds; `Date.now()` has no clock seam. Fix all three; reduce instead of spread.
- `packages/http/src/pipeline.ts:413-416` — finalize-stage loop unguarded, so `handle()` can reject despite the "always resolves to a Response" contract at `:378` (its own comment at `:443-447` anticipates the throw). Wrap; degrade to the coded 500 path.
- `packages/db/src/transaction.ts:90` — `ROLLBACK TO SAVEPOINT` without `.catch`; a dead connection's rollback error masks the original. Match the outer rollback at `:118`.

## Medium

- `packages/i18n/src/interpolate.ts:32-33` — `vars?.[name]` walks `Object.prototype` (`{constructor}` renders the function source). Guard with `Object.hasOwn`; `packages/i18n/src/catalog.ts:59` already uses null-prototype nodes for this reason.
- `packages/i18n/src/interpolate.ts:28` — the `!template.includes('{')` fast path skips `}}` un-escaping (`'a}}b'` unchanged, `'{{a}}b'` → `'{a}b'`). Make the escape symmetric.
- `packages/storage/src/driver-local.ts:46-53` — sidecar parse drops `cacheControl`/`metadata` that `put()` wrote at `:100-105`; `StorageObject` (`driver.ts`) has no fields to surface them. Round-trip fully or refuse like `driver-s3.ts:163-170` does.
- `packages/http/src/rate-limit.ts:75` and `packages/auth/src/rate-limit.ts:51` — unbounded IP-keyed `Map`s, no TTL sweep, no size cap → OOM under rotating-IPv6 scan. Add sweep + cap to both.
- `packages/money/src/money.ts:11` vs `packages/entity/src/types.ts:33` — `Money.minor: number` in one package, `MoneyValue.minor: bigint` in the other; rows read via `pg-row.ts:79-82` aren't assignable to `Money`. Decide one representation (bigint survives the column range), make `Money` fields `readonly`.
- `packages/db/src/client.ts:188-191` — rejecting `close()` leaves `driver` set; next `connect()` returns a half-closed pool. Clear in `finally`.

## Low

- `packages/cache/src/lru.ts:181-188` — `clear()` keeps `hits/misses/evictions`.
- `packages/core/src/lifecycle.ts:129-135` — timed-out `waitForIdle` leaves its waiter in `idleWaiters` forever.
- `packages/storage/src/driver-s3.ts:223` — `list()` hardcodes `application/octet-stream`; local driver reads the sidecar (`driver-local.ts:173`). Two drivers, two answers.
- `packages/http/src/server.ts:181-183` — a throwing `drain()` leaves both shutdown hooks registered; a retry re-runs them.

## Conventions

- `new Date()`/`Date.now()` outside `clock.ts`, nine sites: `packages/entity/src/entity.ts:102`, `query.ts:153`, `pg-driver.ts:74`, `repo.ts:270,286`; `packages/db/src/branch.ts:54,126`, `generate.ts:305`, `pglite-branch.ts:80`; `packages/seo/src/rss.ts:53`; `packages/flags/src/flag.ts:88`. Thread the clock.
- `timingSafeEqual` duplicated byte-identically: `packages/auth/src/tokens.ts:39-46`, `packages/storage/src/signed-url.ts:88-95`. Move to `@ultimat3/core` (tier 0, both may import), delete both copies.
- `packages/schema/src/errors.ts:16-19` — schema (tier 0) exports its codes as data but nothing registers them outside the CLI, so non-CLI processes render fallback titles. Decided: `core` registers them — core owns the registry, schema's codes are few, and no tier edge is crossed (a data-only copy of the titles lives in core, pinned equal to schema's by a test).
- Stale build artifacts checked into `src/`: `.d.ts`/`.js`/`.map` files beside sources — confirmed under `packages/{schema,i18n,time,entity}/src/` (20 `.d.ts`, e.g. `packages/i18n/src/errors.d.ts:6` hardcodes a code list) **and** `packages/jobs/src/`; sweep all of `packages/*/src/` for `*.d.ts`, `*.js`, `*.map`. Delete; add to `.gitignore`; extend the `package-shape` verify step to refuse them so they can't return (axiom 3).
- `packages/seo/src/robots.test.ts:33` — assertion inside an `if (resolveEnvironment() !== 'production')`: zero assertions under `ULTIMATE_ENV=production`. Make it set the env explicitly.

## Tests

- Failing-first test per Critical/High/Medium fix, next to source. Key ones: BEGIN-failure releases connection (`bun test packages/db/src/transaction.test.ts`); concurrent migrators serialize (live suite); oversized value doesn't fail `read()` (`bun test packages/cache/src/tiers.test.ts`); `verifySignedUrl` on `%ZZ` returns `'malformed'`; router 400 on `%ZZ` path; feed with one bad date renders; `interpolate('{constructor}', {})` → `⟦constructor⟧`.

## Done when

- Every finding above fixed or explicitly deferred with a `wiki/Known-Gaps.md` row; new codes registered + documented + `bun run manifest`; `bun run verify` green.
