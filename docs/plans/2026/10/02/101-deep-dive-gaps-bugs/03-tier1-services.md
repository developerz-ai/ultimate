# 03 — time, cache, storage, seo, i18n, flags

> Part of [`overview.md`](overview.md). Depends on: 01. Tier: 1. Path-disjoint from 02.

## Files to change
| Where | Change | Row |
|---|---|---|
| `packages/time/src/cron-occurrence.ts:102` | a wall time mapping to an instant not after `after` under `overlap: 'first'` retries with `'second'` | `s1-t01 #1` |
| `packages/time/src/business.ts:65` | each candidate rebuilt from the calendar date + the original wall time | `s1-t01 #9` |
| `packages/time/src/cron-parse.ts:180,195` | extra range / step parts and prefix-matched names refused | `s1-t01` low |
| `packages/time/src/zoned.ts:172`, `duration.ts:155`, `plain-date.ts:128`, `format.ts:130` | non-integer / NaN refused with a code; year-10000 refused; `formatRelative` by calendar day | `s1-t01` low |
| **new export** `packages/time/src/zoned.ts` | `isoInZone`, moved from `packages/cli/src/tasks-facts.ts:33` (slice 14 deletes the local) | `s2-arch L5` |
| `packages/cache/src/cdn.ts:131`, `:46-48` | purge the entity key with every row tag; `cacheHeaders` emits the entity key with every row tag; `assertPurgeableKeys` at emission | `s1-t01 #2`, `s2-sec L8` |
| `packages/cache/src/tiers.ts:300`, `lru.ts:138` | a refused `set` in `fill` deletes the key in that tier | `s1-t01 #13` |
| `packages/cache/src/lru.ts:53` | `estimateBytes` walks `Map` / `Set` | `s1-t01` low |
| `packages/cache/src/fence.ts:43-44`, `redis.ts:311-335` | a per-tag generation in Redis, bumped by the bust, compared inside the `SET` script | `s1-con #8` (narrowed in `s3-be`) |
| `packages/storage/src/upload.ts:114` | read the ISO-BMFF major brand at offset 8 | `s1-t01 #6` |
| `packages/storage/src/image.ts:76,91,149` | `variantKey` keeps the source extension; width / height through `finiteCount`; height floored at 1; scale clamped at 1 | `s1-t01 #14`, low |
| `packages/storage/src/attachment.ts:146-147` | `promoteAttachment` takes the policy, refuses on `stat().size`; a gone source with a present destination answers the destination | `s2-sec M5`, `s2-con` low |
| `packages/storage/src/driver-s3.ts:282`, `:161` | `get()` takes a byte cap; a missing `lastModified` is "unknown", never epoch 0 | `s2-sec M5`, `s1-t01` low |
| `packages/storage/src/signed-url.ts:186`, `path.ts:115`, `grant.ts:91` | compare against the base's pathname; `isWithinOrg(key, '')` → `false`; the refusal names `grantUpload` (also `grant.test.ts:187,218`, `packages/storage/CLAUDE.md:19`) | `s1-t01` low, `s3-be` New 5 |
| `packages/seo/src/images.ts:13`, `:172` | default `formats` are what the configured driver encodes; `usableWidths` clamped at an exported `MAX_IMAGE_WIDTH` | `s1-t01 #11, #12` |
| `packages/seo/src/rss.ts:126` | Atom `<author>`, `<rights>`, `<icon>`; RSS item authors | `s1-t01 #17` |
| `packages/seo/src/robots.ts:70-75` | `disallow` appended to every group; a `*` group emitted when none exists | `s2-ui #7` |
| `packages/seo/src/meta.ts:162`, `locale-tags.ts:19-21`, `README.md:99` | brand match on word boundary; `ogLocaleTag` from `Intl.Locale` language + region; README matches `packages/core/src/image/pipeline.ts:22-24` | lows |
| `packages/i18n/src/translator.ts:75` | always interpolate | `s2-ui` low |
| `packages/i18n/src/define-catalogs.ts:54`, `locales.ts:123` | `assertLocale` every key before the register loop; a non-numeric `q` is 0 | `s1-t01` low, gaps |
| `packages/flags/src/flag.ts:127`, `runtime.ts:46` | `isIsoDateTime` from core; `reportEveryMs` screened | `s1-t01 #18`, gaps |

## Steps
1. Cron: prove with `*/5 * * * *`, `Europe/Berlin`, walking from `2026-10-25T00:50Z` — twelve occurrences in 01:00Z–02:00Z, and `nextCronOccurrence` agreeing with `matchesCron` at every one.
2. CDN symmetry is a wire change at the edge — one extra key per row-tagged response. State the measured header growth in the CHANGELOG entry. `tagMatches` is the rule every other tier keeps; test all four tiers against one fixture table.
3. Redis fence (`s1-con #8`): contract-level only — two isolated module instances over `packages/cache/src/redis-fake.ts`. If the interleaving cannot be made to fail there, record the row as dropped; do not ship an untested script change. The never-retried boot subscribe (`packages/cli/src/runtime-cache.ts:185-190`) is slice 12.
4. `i18n` always-interpolate changes output for a message containing a literal brace and no vars — run `bun run x -- i18n check --json` in both tracked apps and fix any catalog it now flags.

## Tests
- Files named per row. `packages/cache/src/tag-parity.test.ts` (new) — one fixture through LRU, Redis fake, memo, CDN.
- `bun test packages/time packages/cache packages/storage packages/seo packages/i18n packages/flags`

## Owned elsewhere
- `packages/money/src/format.ts:154` (`trimZeroFraction`), `packages/storage/src/driver-local.ts:279-294` (prefix keys, non-atomic `put`), `signed-url.ts:74` (disk base) — 2026-09-28 plan, slice 01. `s1-t01 #7, #8` and `s2-con` low re-prove them.
- `packages/money/src/allocate.ts:22`, `format.ts:127` (bare `RangeError`) — add to that slice; same files.

## Done when
- No hour of a fall-back night is skipped; a row-tag purge clears a collection-keyed response and the reverse.
- AVIF, HEIC, MOV, M4A pass `validateUpload` when the policy allows them.
- Both tracked apps' `x i18n check` green; `bun run scripts/reference-app-gate.ts` green.
