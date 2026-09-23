# 02 — db, money, time, storage, cache, i18n, seo

> Part of [`overview.md`](overview.md). Depends on: 01 (ISO predicate for time). Tier: 1.

Rule: a generated migration says everything the snapshot records. A public numeric bound is
screened. The URL an operator purges is the one the CDN tagged.

## Files to change

| # | Defect | File:line | Change | Test | Semver |
|---|---|---|---|---|---|
| a | `diffTable` emits SQL only for a type change. A changed or removed `.default()`, or a nullability change, emits nothing while the snapshot records it. The CLI then reports `X_DB_SCHEMA_UNMIGRATED`, and its own fix `x db gen` produces an empty diff, so the gate stays red forever | `packages/db/src/generate.ts:192-199`; `packages/cli/src/schema-diff.ts:56-62`; `packages/cli/src/db-generate.ts:141` | Add an existing-column arm: `alter column … set default <expr>` / `drop default` / `drop not null`, each with its reverse in `down`. For "becomes NOT NULL", reuse the expand/contract note at `generate.ts:212-215` rather than a bare `set not null`. Follow the shape of `redefineIndex` (`index-ddl.ts:217`) | `generate.test.ts`: non-empty `up` for each of the 3 changes. A `generate.live.test.ts` applies one and reads back `information_schema.columns.column_default` | patch |
| b | `reapBranches({ maxAgeMs: NaN })` drops every branch database | `packages/db/src/branch.ts:170-171` | `finiteCount('reapBranches','maxAgeMs', …, 0)` (`migrate.ts:368` pattern), and add the function to the db `CLAUDE.md` screened list | NaN and negative values throw, and no `drop database` is issued | patch |
| c | `rollback()`'s `fix:` puts the ledger `row.id` raw after `#`. A newline in the id ends the comment | `packages/db/src/migrate.ts:476-478` | Encode it as `conflictFix` (`:203`) does | an id containing `\n` is not split across lines | patch |
| d | the statement splitter cuts a `BEGIN ATOMIC … END` body at the inner `;` (suspected) | `packages/db/src/statement-split.ts`, `sql-scan.ts` | Reproduce on PGlite first. If confirmed, track `BEGIN ATOMIC` depth in the scanner | a PG14+ SQL-standard function body stays one statement | patch |
| e | the mcp readonly-sql dollar-tag bug (slice 08 a) may be copied here | `packages/db/src/sql-noise.ts` | Read the tag regex. If it lacks digits after the first char, apply the same fix as 08 a | `$a1$…$a1$` recognised as a tag | patch |
| f | `formatMoney`, `formatMoneyParts` and `formatMoneyDecimal` pass a float to `Intl`, so `money(9007199254740991,'USD',6)` renders `…740992` | `packages/money/src/format.ts:66-68,82`, `money.ts:109-111` | Pass `toDecimalString(amount)`: Intl v3 accepts decimal strings, and Bun does | boundary test at `MAX_SAFE_INTEGER`, scale 6 and scale 2 | patch |
| g | `fromIso` accepts non-ISO text | `packages/time/src/instant.ts:38-44` | Use 01 a's predicate | shared with 01 a | patch |
| h | `promoteAttachment` checks only `isWithinOrg`, so a client-sent key belonging to another row is moved and the victim's copy deleted | `packages/storage/src/attachment.ts:138-145` | Require `isPendingKey(key, orgId)`. New code `X_STORAGE_NOT_PENDING` | promoting an already-attached key throws, and nothing moves | patch |
| i | `sweepOrphans({ olderThanMs: NaN })` deletes a pending upload created a moment ago | `packages/storage/src/attachment.ts:190` | `finiteCount` as at `grant.ts:90` | NaN and negative values throw, and nothing is deleted | patch |
| j | the dev storage secret is accepted when no env is set | `packages/storage/src/driver-local.ts:193` | `isLocal(…, { fallback: 'production' })` (01 e) | with no env, `LocalDiskUnsafeError` | patch |
| k | nothing emits a header a CDN reads. `cacheHeaders()` (`Surrogate-Key`) has no caller; the response path writes `x-cache-tags`, which Fastly and Cloudflare both ignore. Every purge "succeeds" and clears nothing | `packages/cache/src/cdn.ts:25-47`; `packages/http/src/response.ts:211`; `wiki/Configuration.md:227` | `applyCacheHeaders` (http) emits `Surrogate-Key` (space-joined) and `Cache-Tag` (comma-joined) through `serializeTags`, and stops writing `x-cache-tags`. Drop `x-cache-tags` in 18 if anything reads it; otherwise now | a pipeline response with `tags` carries both headers | minor |
| l | `'pt-BR'` is registered but `normalizeLocale` lowercases the request tag and compares it exactly, so a `pt-BR` request always falls back | `packages/i18n/src/locales.ts:64` | Compare case-insensitively and return the registered spelling | `locales.test.ts`: query, header and cookie `pt-br` all resolve to `pt-BR` | patch |
| m | an offsetless `published` value reads in the process TZ, so `pubDate` varies with `TZ` | `packages/seo/src/feed-dates.ts:11` | Reuse `flags/src/flag.ts:124-130`'s screen: an offsetless date-time is treated as absent and logs `seo.feed.date_offsetless` | `TZ=` subprocess test | patch |

## Steps
1. Do a first: it is the only row that leaves the gate permanently red.
2. Register the new code with `bun run new-error-code X_STORAGE_NOT_PENDING --package storage …`.
3. Row k touches `packages/http/src/response.ts` (tier 2). Land it with slice 04 if 04 is in flight, since it has the same owner. The cache-side change is just making `serializeTags` the one serializer.

## Tests
- `bun test packages/db/src packages/money/src packages/time/src packages/storage/src packages/cache/src packages/i18n/src packages/seo/src`
- `TEST_DATABASE_URL=… bun test packages/db/src/generate.live.test.ts`

## Done when
- Changing a column default and running `x db gen` then `x verify` is green, with a migration that sets the default.
- A purge path's tags reach `Surrogate-Key` and `Cache-Tag`.
- No public numeric bound in these packages accepts NaN.
