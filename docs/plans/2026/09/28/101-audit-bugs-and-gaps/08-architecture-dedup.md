# 08 — Architecture: one of each

> Part of [`overview.md`](overview.md). Depends on: 01–07 merged (touches files near theirs). Tier: 0–5.

Axiom 1 (one way) and axiom 3 (enforced). Each row deletes copies in favour of one owner.

## Files to change
| # | Duplicate / drift | Keep | Delete | Enforcer |
|---|---|---|---|---|
| 1 | xxHash32 hex-8 content hash ×3: `render/src/render-static.ts:36`, `cli/src/site-assets.ts:72`, `cli/src/revalidated-response.ts:28` | render's `contentHash`, widened to `string \| Uint8Array` | both cli copies | ETag equality test across the two cli callers |
| 2 | HTML escapers disagree: http 5 chars (`html-render.ts:11`), mail 5 (`mail/src/html.ts:14`), cli 4 (`cmd-shot-matrix.ts:97`), admin 3, no quotes (`admin/src/dev/server.ts:88`) | http's | mail, cli, admin copies | lint/guard: no local `escapeHtml` outside http |
| 3 | `readCookie` + `decodeCookieValue` twice at tier 2: `auth/src/session.ts:284`, `http/src/locale.ts:52` | move to `core` | both | — (sideways import impossible, so one owner below) |
| 4 | Two public `Page` types, opposite cursor meaning: `entity/src/repo.ts:75` (`nextCursor`, null = last) vs `query/src/pagination.ts:23` (`endCursor`, `hasNextPage`) | query's (wire shape) | entity's; reshape `batch.ts:103`, `preload.ts:93` | typecheck |
| 5 | `fnv1a` ×2: `ai/src/embeddings.ts:107`, `flags/src/bucket.ts:17`; `ai/src/llm-cache.ts:122` keys a stored cache on 32-bit variable-width hex → collisions overwrite | flags' (bucketing needs FNV) | ai's; key llm cache on core `fingerprint` | cache test with two colliding inputs |
| 6 | Sideways-edge prose hand-written and wrong: `docs/architecture/02-boundaries.md:28` (deleted `cli → scraping`, missing `core → schema`), `llms.txt:56`, `packages/scraping/CLAUDE.md:23-24` | generate from `SIDEWAYS_ALLOW` into `llms-txt.ts`'s generated block | hand lists | existing generated-block drift check |
| 7 | Step-name subsets typed `string`: `PREFLIGHT_STEPS` (`cli/src/cmd-build.ts:188`), `BESIDE_SERIAL_SUITES`, `SERIAL_SUITES` (`verify-run.ts:150,160`) | — | — | type as `VerifyStepName` → `TS2322` on a stale name |
| 8 | Stale "still throws" comments for deleted `createOpfsLocalStore`: `core/src/config.ts:163`, `cli/src/templates/scaffold-repo.ts:178`; unused `NotImplementedError` in `realtime/src/errors.ts:409` | — | the clauses + export | — |

## Steps
1. Rows 7, 8 first (cheap). Then 1, 2, 5. Then 3, 4, 6, each its own commit.
2. Row 3: add to core with a 1-line header; `bun run boundaries` must stay green.
3. Row 4 is a public type change → CHANGELOG + `wiki/Upgrading.md` if `Page` from entity is exported to apps.

## Tests
- Per row as in the Enforcer column; `bun run typecheck`, `bun run boundaries`, `bun run lint`.

## Not a bug (don't reopen)
- `stableStringify` vs `canonicalJson` (separate on purpose); `FLOOR_ABOVE` rows for policy/pwa/render/ui; `core/src/index.ts` size (re-export list exempt); `configureHttp()` outside `app.config.ts`; `PLANNED_COMMANDS`; `query/src/stable.ts`, `realtime/src/json.ts`; `configureActionPathStyle`.

## Done when
- Each "Delete" cell has 0 grep hits; `bun run verify` green.
