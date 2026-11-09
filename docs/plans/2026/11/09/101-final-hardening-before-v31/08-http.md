# 08 — http: configs that work as written, bounded bodies, scalable limits

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 2 (`http`). Semconv attribute names are [`20`](20-observability.md).

## Findings
| # | Sev | Site | Failure | Fix |
|---|---|---|---|---|
| H1 | Med | `http/src/cors.ts:65-78` | `assertCorsConfig` accepts `'https://app.com/'`, `'https://App.com'`, `'https://app.com:443'`, `'app.com'`; `originListed` (`:89`) is exact, so each gets no CORS headers, a 403 preflight and refused writes. Proved | every entry but `'*'` must satisfy `URL.parse(o)?.origin === o`, else `corsConfigInvalid` with the canonical form in `fix` |
| H2 | Med | `http/src/server.ts:362-370` | `Bun.serve` has no `maxRequestBodySize`; above Bun's 128 MiB default Bun answers its own uncoded 413 before framework code (a signed upload grant can exceed it) | set it to `max(bodyLimitBytes, uploadCeilingBytes)` from config; [`04`](04-storage.md) refuses single-request grants above it at signing time, pointing to multipart |
| H3 | Med | `http/src/rate-limit-postgres.ts:60-81` | one row-locked upsert per counted request; a hot key (one NAT, a global bucket) serialises every request on one row. No Redis store although Redis is already a cache dependency | `redisRateLimitStore` (one Lua token bucket) beside memory and Postgres; conformance in [`19`](19-conformance-suites.md) |
| H4 | Med (perf) | `http/src/rate-limit-postgres.ts:34` | `x_rate_limit_updated_at_idx`: `idx_scan = 0` in production (34 days); purge runs off `last_ms` (`cli/src/runtime-purge.ts:151-156`). Pure write cost on the hottest write table | `drop index if exists` in the framework schema; framework drift fixture updated |
| H5 | Low–Med (security) | `http/src/rate-limit.ts:395` (`rateLimitSpends`) | IPv6 keyed by full address: one /64 holder gets a fresh bucket per request (acknowledged in `auth/src/kdf-gate.ts:3-6`) | key IPv6 by /64 (v31-break: bucket keys change; note in `wiki/Upgrading.md`) |
| H6 | Low | `http/src/rate-limit-buckets.ts:58,81`, `assertRouteBuckets` | `buckets[name]` without `Object.hasOwn`: `rateLimit: 'constructor'` → conflict error naming "undefined"; `'__proto__'` write sets the prototype | `Object.hasOwn` read (`rate-limit.ts:436`), `defineProperty` write (`policy/src/roles.ts` `put()`) |
| H7 | Low | `http/src/compress.ts` (`inBounds`: 1–256 KiB with declared length) | bodies > 256 KiB and all streams (NDJSON, CSV, large JSON) go uncompressed; when it runs it is sync `gzipSync` (256 KiB ≈ 1.3 ms) | outside the window, or with no declared length: `CompressionStream('gzip')`. `private`/`no-store` stay excluded |
| H8 | Low (ops) | the `X_UNAUTHENTICATED` log path | every anonymous hit on an auth page logs at warn; in prod mostly scanners | log expected 401s at info |
| H9 | Med (adopter-found) | `http/src/auth-redirect.ts:23-38` (`signInRedirect`) | `${signInPath}?next=…` ignores the routed locale; an adopter ships a 302 shim | take the routed locale of the request path |
| H10 | Low (adopter-found) | `http/src/locale.ts:35` | the `x_timezone` cookie name lives only in a server barrel; an adopter restates it | export from a browser-safe entry |
| H11 | Low | `http/src/byte-range.ts` | `bytes=5-3` → 416; RFC 9110 §14.1.1: an invalid range spec is ignored → 200 full | ignore unsatisfiable-by-syntax ranges; keep 416 for out-of-size ranges |

## Files to change
- `packages/http/src/cors.ts`, `server.ts`, `config.ts` (body ceiling field), `rate-limit-postgres.ts`, `rate-limit-redis.ts` (new), `rate-limit.ts`, `rate-limit-buckets.ts`, `compress.ts`, `auth-redirect.ts`, `locale.ts`, the browser entry that re-exports it, `byte-range.ts`, the error-log level site, `index.ts` (export the Redis store).
- `packages/http/README.md`, `wiki/Upgrading.md` (H5).

## Tests
- `cors.test.ts`: the four spellings refused with the canonical form in `fix`.
- `server.test.ts`: 200 MiB body over a 250 MiB config ceiling reaches the handler; over the ceiling → coded 413.
- `rate-limit-redis.live.test.ts` + the shared conformance (19).
- `rate-limit.test.ts`: two addresses in one /64 share a bucket.
- `rate-limit-buckets.test.ts`: `constructor`, `__proto__` buckets.
- `compress.test.ts`: NDJSON stream with `accept-encoding: gzip` → gzip, no content-length.
- `auth-redirect.test.ts`: `/es/account` → `/es/login?next=…`.
- `byte-range.test.ts`: `bytes=5-3` → 200.
- `bun test packages/http`

## Done when
- Every finding's test is green; the drift check shows the dropped index.
