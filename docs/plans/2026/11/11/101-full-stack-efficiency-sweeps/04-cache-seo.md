# 04 — cache and seo: bounded memo, a cheaper byte count, one clock seam

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 1. Small; shares a sweep with [`03`](03-db.md).

## Findings

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| K1 | P3 | plausible (not measured) | `packages/cache/src/memo.ts` (`memoTier`, the per-ctx `Map` behind the `stores` WeakMap) | The request memo has no bound. It dies with the ctx, but a job's ctx is the whole attempt — the reason `packages/entity/src/jit-preload.ts:71-86` grew `MAX_SIBLING_KEYS` after 159 MB was measured retained | measure first: a `backfill()` reading through a `cache:` query per batch, heap before and after. If it grows: a byte bound per ctx (8 MiB), oldest evicted, silently (the memo is best-effort) |
| K2 | P3 | confirmed (read) | `packages/cache/src/lru.ts:158` | `estimateBytes(text)` runs `TextEncoder.encode` — a full copy — only to count bytes, on every `set` | count UTF-8 length from code units (surrogate pairs = 4, lone surrogate = 3), no allocation |
| K3 | P3 | gap; 1 adopter wrote its own | `packages/cache/src/memo.ts` (`requestMemo` is query-only) | No per-request memo for a plain function | `memoPerRequest(fn, key)` over the same store as `memoTier`: one mechanism, one more entry point; outside a ctx it calls through |
| K4 | P3 | confirmed (read) | `packages/seo/src/sitemap.ts:161` (option at `:80`) vs `rss.ts:55,256` | `options.now ?? new Date()`: a second clock seam beside `clock?: Clock` | `clock?: Clock` defaulting to `systemClock`, read once. `now` stays as a deprecated alias on `main`; its removal waits on `next` |

Checked and fine, not planned: single-flight with a 30 s deadline, `negativeTtlMs`, TTL jitter with an injected `rng`, the Redis pub/sub invalidation bus, tag and entity index cleanup on unlink. A Redis `set` is three sequential round trips by design (the bust race).

## Files to change
- `packages/cache/src/memo.ts`, `lru.ts`, `index.ts`; `packages/cache/README.md`.
- `packages/seo/src/sitemap.ts`; `packages/seo/README.md`.
- Coordinator only: changelog (K4 deprecation), `bun run manifest`.

## Steps
1. K1: the measurement decides; write the number in the PR whichever way it goes.
2. K2–K4: one worker, one afternoon.

## Tests
- `packages/cache/src/lru.test.ts` — byte count unchanged for ASCII, BMP, astral and lone surrogates (property test against `TextEncoder`).
- `packages/cache/src/memo.test.ts` — N MiB written under one ctx stays ≤ the bound (if K1 ships); `memoPerRequest` calls `fn` once per ctx and key, and every time outside a ctx.
- `packages/seo/src/sitemap.test.ts` — a frozen clock drives the default `lastmod`.
- Command: `bun test ./packages/cache/src/<file>.test.ts`.

## Done when
- No allocation in `estimateBytes` (property test green).
- `memoPerRequest` exported and documented; adopter H's wrapper is deletable ([`47`](47-adopter-h.md)).
- `sitemap` and `rss` read time the same way.
