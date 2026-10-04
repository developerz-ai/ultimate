# 04 — Correctness: parity, contracts, unscreened inputs (tiers 0–4)

> Part of [`overview.md`](overview.md). Depends on: 03 merged. Tier: 0–4. **Sweep 4.**
> Probed at `d7b8c7fa` unless *read*. As of 2026-10.

## Rule
Two implementations of one seam (memory vs Postgres, streamed vs non-streamed, TS vs emitted worker)
answer the same input the same way — pinned by a parity test, not a comment.

## Agents (≤ 4, disjoint)
| Agent | Exclusive paths |
|---|---|
| A — http/i18n/time | `packages/http/src/{auth-redirect,error-page}.ts`, `packages/i18n/src/catalogs/en.json` (coordinator merges keys), `packages/time/src/{cron-occurrence,business}.ts` + tests |
| B — ai parity | `packages/ai/src/{vector,openai-wire,budget}.ts`, `packages/ai/README.md` + tests (incl. `provider-parity.test.ts`) |
| C — pwa/mail/ui | `packages/pwa/src/{offline-fallback,strategies}.ts`, `packages/mail/src/transform.ts`, `packages/ui/src/components/ErrorState.tsx` + tests |
| D — realtime decode | `packages/realtime/src/{pg-values,pg-connection}.ts` + tests |

## Findings → fix

| # | Sev | Where | Defect | Fix | Test |
|---|---|---|---|---|---|
| C1 | Medium | `packages/http/src/auth-redirect.ts:59-80` (`nextAfterSignIn`) | Double decode: `/search?q=a%26b` → `?q=a&b`; `100%25done` → invalid Location / throw → fallback. Test `auth-redirect.test.ts:122` contradicts its own title | Drop `decodeURIComponent`; screen and return `raw`. Re-baseline `:85,98,107-109,116-117,122` | "signInRedirect → nextAfterSignIn round trip lands on the original path and query" (`%26`, `%25`) |
| C2 | Low | `packages/http/src/error-page.ts:168,172` | Production error page hardcodes `code` / `request` labels | `errors.page.code`, `errors.page.request` in `packages/i18n/src/catalogs/en.json`, render via `t()` like `:177` | `error-page.test.ts` "every visible label is a catalog key" (non-English catalog) |
| C3 | Low | `packages/time/src/cron-occurrence.ts:194` | `count` unscreened: `NaN` → `[]`, `2.5` → 3, `Infinity` → infinite loop | `finiteCount('nextCronOccurrences', 'count', count, 0)` (pattern `entity/src/mfa.ts`) | `cron-occurrence.test.ts` NaN/Infinity/2.5 refused |
| C4 | Low | `packages/time/src/business.ts:72` | Guard exhaustion returns a non-business day silently | `throw scheduleInvalid('calendar', …, 'a calendar with at least one business day')` | `business.test.ts` all-weekend calendar refuses |
| C5 | Medium | `packages/ai/src/vector.ts:151` (+ `embeddings.ts:126`) | Memory store ranks by dot product, pgvector by cosine (`pg-vector-sql.ts:124-132`) → dev/prod order differ for non-unit vectors | True cosine in `MemoryVectorStore.search` | `vector.test.ts` "memory search ranks by cosine, not magnitude (pg parity)" |
| C6 | Low | `packages/ai/src/vector.ts:261-271` (`fuse`) | Keys by `id` only; pg groups by `(tenant, id)` → unscoped hybrid merges two tenants' rows | Fuse on stored tenant + id inside `MemoryVectorStore.hybrid`; `fuse()` signature unchanged | `vector.test.ts` "unscoped hybrid keeps same-id rows of two tenants apart" |
| C7 | Low | `packages/ai/src/openai-wire.ts:107,114` vs `:241` | `"refusal": ""` is a refusal non-streamed, not streamed | Present only when `typeof === 'string' && !== ''` on both paths | `provider-parity.test.ts` "an empty refusal string is not a refusal on either path" |
| C8 | Medium | `packages/ai/src/budget.ts:106` (`budgetKeysFor`) | `orgId: ''` / `null` → shared `org:` / `org:null` window for every org-less caller | Three-way `orgless` test from `packages/query/src/cache.ts:64-65`; omit `orgKey` | `budget.test.ts` "an org-less actor carries no org key, in all three spellings" |
| C9 | Low | `packages/ai/README.md:340,357` | "No `hive()`" while `hive()` ships; "The fourth factory" ordinal | Delete the sentence and the ordinal (`hive.ts:4-6`) | — (doc) |
| C10 | Low | `packages/pwa/src/offline-fallback.ts:15,25,85` | `pwa.offline.font` accepted, never emitted; `wiki/Configuration.md:288` says it is read | Emit `OFFLINE_FONT` with a `req.destination==='font'` branch beside the image one | `offline-fallback.test.ts` "a configured font fallback reaches the emitted worker" |
| C11 | Low | `packages/pwa/src/strategies.ts:239-241`; `strategies.test.ts:88-91` | Parity "test" only greps the name; TS SWR throws `X_PWA_STRATEGY_EXHAUSTED`, emitted returns `Response.error()`; TS awaits `cache.put`, emitted does not | Run each `STRATEGY_SOURCE` via `new Function` against the behaviour fake; align TS to the emitted semantics | `strategies.test.ts` "each emitted strategy answers what its TS twin answers" |
| C12 | Low | `packages/mail/src/transform.ts:106`; `packages/ui/src/components/ErrorState.tsx:46` | `instanceof Error` / `.name` inside the coding catch → exotic throwable escapes uncoded | Read via core `stringField` (as `ai/src/gateway.ts`), wrapped in `try` | `transform.test.ts` "an exotic throwable still fails as X_MAIL_TRANSFORM_FAILED"; `ErrorState` test with a throwing-getter error |
| C13 | Low | `packages/realtime/src/pg-values.ts:41-42`; `pg-connection.ts:121` | Seconds offset (`-04:56:02`, pre-standard-time timestamptz on non-UTC servers) decodes as a raw string → live row ≠ repo row. *medium confidence* | Add `-c TimeZone=UTC` to startup `options` **and** accept `(?::\d{2})?` seconds | `pg-values.test.ts` "a seconds offset decodes to the same instant" |

Tier-5 correctness rows (cli, scripts, testing, scraping) are [`06-cli-ci-tooling.md`](06-cli-ci-tooling.md).

## Steps
1. Branch `fix/sweep-4-correctness`. Brief A–D.
2. Failing test first; narrowed checks.
3. Coordinator: i18n keys, CHANGELOG `Fixed`, `bun run verify`, PR, reviews, merge.

## Done when
- C1–C13 pinned; `bun run verify` green; merged.
