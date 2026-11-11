# 01 — Hotfix patch: the confirmed defects, shipped first

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 1 → 5. Ships alone as a patch release; adopter E's chunk 429s end on upgrade with no app change.

No new error code, no new public name except the `assets` rate-limit bucket. Every row is a failing-first test, then the fix.

## Findings

| ID | Sev | Status | Finding | Failure |
|---|---|---|---|---|
| H1 | P1 | confirmed (code) | Built-asset routes carry no `rateLimit`: `packages/cli/src/island-routes.ts:26-27`, `style-routes.ts:31`, `site-asset-routes.ts:68`, `worker-bundle.ts:207`, `runtime-assets.ts:263,286`, `favicon.ts:111`, `pwa-artifacts.ts:260`. `routeBucketOf` (`packages/http/src/rate-limit-stage.ts:84-86`) charges each to `default` (`rate-limit-config.ts:18,21`: burst 120, then 2/s, per address) | an office behind one NAT, or a fast reload, gets 429 on content-hashed chunks. Measured by an adopter: 429 from the fifth route on |
| H2 | P1 | confirmed (read) | `packages/cli/src/mcp-host.ts:257` throws `X_DB_MIGRATE_FAILED` with `fix: 'x db reset'`. The registered fix is `x doctor --json` (`packages/cli/src/mcp-errors.ts:179`, `wiki/Error-Codes.md:316`) | an agent follows the fix and wipes the embedded database |
| H3 | P2 | confirmed (probe) | `packages/query/src/read.ts:278`: the read-cache key is built from the raw input. `coerceQuery` keeps unknown search keys | `?junk=N` is a new tier entry and a database read per N, and evicts hot entries |
| H4 | P3 | confirmed (code) | `packages/realtime/src/live-definition.ts:140,171`: the live window key hashes the raw input | one socket varying a junk key opens identical windows, one read and one fan-out lane each |
| H5 | P2 | confirmed (code) | `packages/realtime/src/live-fanout.ts:53-56` with `live-entries.ts:67`: every cold window (`applied === 0`) is marked stale by any change on the node, whatever its table | each new window on a busy node reads twice and re-snapshots every subscriber |
| H6 | P3 | confirmed (probe) | `packages/money/src/convert.ts:133`: the same-currency branch of `convertWith` calls `options.at.toISOString()` unscreened | an Invalid Date throws a bare `RangeError`; the cross-currency path answers `X_RATE_MISSING` |
| H7 | P3 | confirmed (read) | `packages/admin/src/form-decode.ts:114`: an unparseable datetime becomes an Invalid Date, against the file's own header | the schema's message no longer names what was typed |
| H8 | P3 | plausible | `packages/cli/src/mcp-host.ts:308`: `logs.tail` reads the whole `dev.log`; `role` is not screened as a path segment | a large log is read into memory per call; `role: '../x'` |
| H9 | P3 | plausible | `packages/cli/src/cmd-drill.ts:150`: `bunDrillSql(...)` is built before the `try` whose `finally` stops the fleet | a constructor throw leaks the spawned role processes |
| H11 | P1 | confirmed (probe) | `packages/query/src/source.ts:143-156` with `pagination.ts:85-101` | a `from(entity, () => repo.fetch(N))` provider never receives the cursor: rows past its window are unreachable and page two can be empty. Shipped in the reference app (`examples/dummy/apps/web/app/posts/queries/org-posts.ts:17`). Full row: [`08`](08-action-query.md) Q1 |
| H12 | P1 | confirmed (schema dump) | `dummy/social-media-clone/packages/db/migrations/20260824215827_rename_ordered_and_partial_indexes.sql:5-11` | 7 duplicate indexes in the deployed demo. Full row: [`18`](18-tracked-apps.md) A1 |
| H10 | P3 | plausible | `packages/jobs/src/limits.ts:235-240`: past `maxTenants` the sweep evicts the tenants with the fewest live stamps | an evicted tenant with a live window gets its whole `ratePerTenant` back |

## Files to change
- `packages/http/src/rate-limit-config.ts` — H1: an `assets` bucket in the defaults (start: capacity 2,000, refill 200/s; record the reasoning beside it).
- `packages/cli/src/asset-route-meta.ts` (new) — H1: `assetRouteMeta()`, the one place an asset route's `tags: ['assets']` and `rateLimit: 'assets'` are written.
- the seven cli files in H1 — call it. `packages/cli/src/asset-route-meta.test.ts` — every registered route tagged `assets` names the `assets` bucket (walk the built route table of `examples/dummy`), so a new asset route cannot forget.
- `packages/cli/src/mcp-host.ts` — H2: `fix` from `CODE_FIXES.X_DB_MIGRATE_FAILED`; H8: `Bun.file(path).slice(-N)` and `role` ∈ `DEV_ROLES`.
- `packages/query/src/read.ts` — H3: return the parsed input from `buildSource`/`admit` and key on it (pattern: `packages/query/src/download-token.ts:88`). `packages/query/CLAUDE.md` — the caching invariant line.
- `packages/realtime/src/live-definition.ts`, `live-query.ts` — H4: hash the parsed input before the qid.
- `packages/realtime/src/live-fanout.ts` — H5: in the cold branch, stale only if `entry.shape.entities.includes(change.table)` (the guard `truncated()` already uses at `:210`).
- `packages/money/src/convert.ts` — H6: screen `at` as `convert` does at `:71`.
- `packages/admin/src/form-decode.ts` — H7. `packages/cli/src/cmd-drill.ts` — H9.
- `packages/query/src/source.ts`, `pagination.ts`; `examples/dummy/apps/web/app/posts/queries/org-posts.ts` — H11: the provider's function form receives `{ after, limit, order }`.
- `dummy/social-media-clone/packages/db/migrations/<new>.sql` — H12: `drop index concurrently` × 7; `bun run schema-dumps`.
- `packages/jobs/src/limits.ts` — H10: evict windows with `live === 0` first; if none, state the drop in the header.

## Steps
1. One worker per band (see the sweep table); each writes the failing test first and shows it red.
2. H1: confirm with a probe before fixing — 300 chunk GETs from one address against `examples/dummy` built static + app. Record the 429 count in the PR.
3. H3/H4 share a root cause; fix `query` first, `realtime` reads the parsed input from it (`realtime → query` is a declared edge).
4. Coordinator: changelog entry + `wiki/Upgrading.md` (the `assets` bucket is new behaviour: an app that overrode `default` to throttle assets must now name `assets`), `bun run manifest`, `bun run verify`.

## Tests
- `packages/cli/src/asset-rate-limit.test.ts` — 300 island-chunk GETs from one address: no 429; 121 action POSTs: 429.
- `packages/cli/src/mcp-host.test.ts` — a failing migrate rethrows with the registered fix; a 200 MB log returns its tail; `role: '../x'` refused.
- `packages/query/src/read-cache-key.test.ts` — `{q}` then `{q, junk}`: `executed === 1`; HTTP `?junk=` likewise.
- `packages/realtime/src/live-definition.test.ts` — two subscribes differing by a junk key: one entry, one read. `live-fanout.test.ts` — cold entry on table A, change on table B during its read: one read, `stale === false`.
- `packages/query/src/pagination.test.ts` — a window-honouring provider walks all 100 rows over 10 pages.
- `packages/money/src/convert.test.ts`, `packages/admin/src/form-decode.test.ts`, `packages/cli/src/cmd-drill.test.ts`, `packages/jobs/src/limits.test.ts` — one case each, as the Failure column.
- Commands: `bun test ./packages/<pkg>/src/<file>.test.ts`.

## Done when
- Twelve rows; every code row has a test red before and green after.
- `bun run verify` green; patch released; the demo serves nine cold routes from one address with zero 429 (GETs only, ≤ 30 requests).
