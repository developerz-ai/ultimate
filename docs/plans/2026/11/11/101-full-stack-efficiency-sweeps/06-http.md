# 06 — http: the request floor, compression, and a rate limit that does not write WAL per request

> Part of [`overview.md`](overview.md). Depends on: [`02`](02-schema-core.md) (logger and metric keys are part of the same floor), [`03`](03-db.md) D4 (storage parameters). Tier: 2.

Measured in-process, no socket, 30k requests: a public `GET` answering `'ok'` costs ~150 µs through `pipeline.handle`, a 404 ~207 µs. No single hotspot. Axiom 9: the number is pinned as a bench claim, then lowered.

## Findings

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| H1 | P2 | confirmed (measured) | `packages/http/src/pipeline.ts:243` (`handle`) | Shares of request CPU: `requestContext`/`ctxOf` 13%, `response` stage 12% (`Object.entries` over the memoised security headers + ~15 `headers.set`), `locale`/`resolvePreferences` 8.5%, rate-limit 7% (`addressNetwork` parses the address every request), `startDeadline` timer 5.8%, `readCorrelation`/`uuidV7` 5%, `recordRequest` 4.3% | first a bench: `scripts/bench/http-pipeline.bench.ts` (new; in-process through `pipeline.handle`, no socket — `scripts/bench/http-hello.ts` is the over-the-wire tool and stays), its JSON under `scripts/bench/results/`. Then: security headers precomputed as one entries array at boot and applied in one loop; `addressNetwork` memoised per address in a bounded LRU (4,096); the locale stage short-circuits when the route declares one locale and no preference cookie is present; one shared deadline timer wheel instead of a timer per request (measure: only if it shows) |
| H2 | P3 | confirmed (profile) | `packages/http/src/error-facts.ts:110` (`failureStack(error)`) | `factsOf` reads `.stack` on every refusal: an expected 404/401/403/429 pays Bun's lazy stack render (~3.5 µs; 8.8% of a 404). Production never shows a 4xx stack | `stack` a lazy getter on `ErrorFacts`, read only for a 5xx, in dev, or when a failure capture or error reporter is active |
| H3 | P2 | confirmed (live: `Accept-Encoding: br` gets the identity body, 18,628 B) | `packages/http/src/compress.ts:84` (gzip only), `:129,148` | No brotli or zstd; every public compressible answer is gzipped again on every hit (`gzipSync` ~2.35 ms at 256 KiB by the file's own figure) | (a) check what Bun's `CompressionStream`/`Bun.*` offers natively for `br` and `zstd`; negotiate the best the runtime has, gzip otherwise. (b) a bounded LRU of compressed bodies keyed `(strong ETag, encoding)` for answers with a public `cache-control`. (c) hashed static assets precompressed at build (`.br` + `.gz` beside each, served by `Accept-Encoding`): [`11`](11-render-islands.md) |
| H4 | P3 | confirmed (live + read) | 200: `packages/http/src/compress.ts:122-124` weakens to `W/"h"`; 304: `packages/cli/src/revalidated-response.ts:29-35`, `packages/http/src/object-response.ts:66-67`, `packages/cli/src/static-document.ts:106` answer strong `"h"` | The 304's validator differs from the 200 it revalidates (RFC 9110 §15.4.5): a cache that updates stored headers from the 304 holds a strong ETag for gzip bytes. `/feed` and `/signin` carry no ETag while declaring `s-maxage` | one helper decides the validator's form from the same `acceptsGzip`/`inBounds` decision and all four sites call it. SSR documents with a public `cache-control` always carry one |
| H5 | P2 | confirmed (production: 10,540 upserts, 4% HOT, 3,259 autovacuums on a 160 kB table); design plausible | `packages/http/src/rate-limit-postgres.ts:23-35` (DDL), `:64-86` (`SQL_RATE_LIMIT_TAKE`) | Every take is a WAL-logged whole-row upsert; `updated_at = now()` is written though nothing reads it since v31 | step 1, exact semantics kept, safe with N replicas: `x_rate_limit` declared `unlogged` with `fillfactor = 70` through [`03`](03-db.md) D4; drop the `updated_at` write. After a crash buckets come back full — a brief free burst, never a lockout. **`x_auth_lockouts` stays logged.** Step 2 only if step 1's numbers are not enough: per-process token blocks, opt-in per bucket, never on auth or tenant buckets (over-admission ≤ replicas × block) |
| H6 | P2 | confirmed (production pod logs: no such line) | `packages/http/src/` (only `Server-Timing` exists) | No slow-request log line and no access log | a threshold line from the same instrumentation the `Server-Timing` header reads: `http.request.slow` at `warn` with route pattern, status, total and per-stage ms, db statement count and ms, the correlation id. Default 1,000 ms; off below. No per-request access log: the metric and the trace are that record |
| H7 | P3 | confirmed (production: 5 lines in 13 min from one scanner) | the stage that refuses `auth: 'required'` routes | `X_UNAUTHENTICATED` logs one `info` line per anonymous hit | counted (`http_refusals_total{code}`) and logged at `debug`; `info` kept for the first per route per minute |
| H9 | P3 | partial (`packages/http/src/stages.ts:478`: `total` only) | `Server-Timing` | No breakdown | `db;dur`, `render;dur`, `cache;dur` from the `db.statement` and render bus events, under `x dev` or a trusted-request flag only (never to the public: it leaks timing) |
| H10 | P2 | partial; **owner decision OD1** | `packages/http/src/stages.ts:162` (`maxInflight`), `packages/core/src/process-metrics.ts:126` (lag measured, not acted on) | CPU-bound SSR saturation is the one overload a static in-flight ceiling cannot see | the admit stage also sheds 503 + `Retry-After` while event-loop lag p99 exceeds `http.shedLagMs`. Default on changes overload behaviour for every app: ships default **off** unless OD1 says otherwise; a drill (`x drill`) proves it |
| H8 | P3 | confirmed (live) | `/x-sw-register.js` served uncompressed; rate-limit headers on every response | 613 B script below the compression floor: fine. Headers: fine. | none — recorded as checked |

Checked and fine, not planned: the router (a trie: 3.1 µs at 501 routes, 5.2 µs at 50,001), csrf, the memory rate-limit store's bounded sweep, `etagMatches`, streaming compression past 256 KiB, body ceilings.

Not read in three passes: `request.ts` body parsing, `bearer-mount.ts`, the websocket upgrade path. The sweep's security review pass reads them ([`overview.md`](overview.md) *Risks*).

## Files to change
- `scripts/bench/http-pipeline.bench.ts`, `http-pipeline.bench.test.ts` (new), `scripts/bench/results/http-pipeline.json`, `results/README.md` — H1.
- `packages/http/src/pipeline.ts`, `stages.ts`, `response.ts`, `rate-limit-stage.ts`, `deadline.ts` — H1.
- `packages/http/src/error-facts.ts` — H2.
- `packages/http/src/compress.ts`, `compress-cache.ts` (new) — H3.
- `packages/http/src/etag-form.ts` (new), `compress.ts`, `object-response.ts`; `packages/cli/src/revalidated-response.ts`, `static-document.ts` — H4 (the two cli files join this slice's lock for the sweep).
- `packages/http/src/stages.ts` — H9, H10.
- `packages/http/src/rate-limit-postgres.ts` — H5.
- `packages/http/src/slow-request-log.ts` (new), the refusal stage — H6, H7.
- `packages/http/README.md`, `CLAUDE.md`; `wiki/` deployment page (compression, the unlogged table's crash semantics).
- Coordinator only: changelog + `wiki/Upgrading.md` (H5 persistence change, H7 level), `bun run manifest`.

## Steps
1. Bench first, on `main` before any change: record µs for hello and 404. Every later PR in this slice and in [`02`](02-schema-core.md) quotes its before/after.
2. H2, H1's header and address items: one worker.
3. H3: probe the runtime first (ten lines); the encodings table in `compress.ts` lists only what the probe proved. `Vary: Accept-Encoding` stays exact.
4. H5: the DDL change applies to existing tables: `alter table … set unlogged` rewrites the table under an `ACCESS EXCLUSIVE` lock — tiny here, but run it under the migrate role's `lock_timeout` and say so in Upgrading.
5. H6/H7: one worker; the line's fields reuse the semconv names.

## Tests
- `scripts/bench/http-pipeline.bench.test.ts` — the bench's shape, and a **work-count** pin (allocations and stage calls per request), never wall time: benches are not gate steps (`.github/workflows/bench.yml:6`). The µs figure is published JSON that `bun run scripts/bench-claims.ts` holds prose to (`X_BENCH_CLAIM_STALE`).
- `packages/http/src/error-facts.test.ts` — a 404 never touches `.stack` (spy getter); a 500 carries it.
- `packages/http/src/compress.test.ts` — negotiation picks the best proven encoding; same strong ETag served twice compresses once; a private answer is never cached.
- `packages/http/src/object-response.test.ts` — the 304's validator equals the 200's, byte for byte.
- `packages/http/src/rate-limit-postgres.live.test.ts` — `relpersistence = 'u'`, `fillfactor=70`; HOT ratio > 0.9 after 1,000 takes on one key; semantics suite unchanged.
- `packages/http/src/slow-request-log.test.ts` — a 1.2 s request logs one line with stage timings; a fast one none.
- Command: `bun test ./packages/http/src/<file>.test.ts`.

## Done when
- Hello and 404 at least 20% under the first recorded bench, with the claim in `scripts/bench/results/`.
- The demo answers `Accept-Encoding: br` (or zstd) with that encoding if the runtime has it; otherwise the probe's verdict is written in `compress.ts`'s header.
- A rate-limit take writes no WAL (live test) and behaves identically.
- A slow request in production is one line with its stages.
