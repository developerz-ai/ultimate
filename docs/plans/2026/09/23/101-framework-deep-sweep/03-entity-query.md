# 03 — entity + query: two drivers, one meaning

> Part of [`overview.md`](overview.md). Depends on: 02. Tier: 2 (entity), 3 (query).

Rule: the memory driver and the Postgres driver return the same value, or refuse the same way, for
every write and read. A new `*-parity.test.ts` runs both drivers for each row below, which is what
turns the rule into a build error rather than a sentence.

## Files to change

| # | Defect | File:line | Change | Semver |
|---|---|---|---|---|
| a | a patch key present with value `undefined` is written as NULL by `update`/`updateWhere` in both drivers. This contradicts `plan.ts:199-203`, and the common case is "patch from optional action input", so data is wiped | `packages/entity/src/pg-row.ts:86-89` (`bindable` `:139-140`), `memory-repo.ts:261,317`, `query.ts:422` (`touch`) | Skip `value === undefined` in `bindValues` (like `namedColumns`) and before `Object.assign` in memory | patch. Note it in CHANGELOG as a behaviour fix; an app relying on undefined meaning NULL must pass `null` |
| b | memory silently replaces a row on a duplicate PK insert; ignores `unique()` columns; and on a PK patch keeps both the old and the new key | `packages/entity/src/memory-repo.ts:119-135` (`write`) | Delete the old key when `storeKey(merged)` moves, and register the undo. Refuse an existing key on `insert`/`insertAll`. Check `$indexes` unique entries with `X_DB_UNIQUE_VIOLATION`'s shape | patch |
| c | `transitionRow` filters on the literal `id`, so `.transition()` breaks on any entity keyed by another column (false `X_STATE_CONFLICT` in memory, `X_INVARIANT_VIOLATED` on Postgres) | `packages/entity/src/transition.ts:112` | Key the filter on `singleKeyOf(entity,'transition')` (`plan.ts:196`) | patch |
| d | `decimal()`/`bigint()` `$parse` does not canonicalise, so memory returns `'007.5'` where Postgres returns `7.50`, and `sum`/`max` differ | `packages/entity/src/columns-data.ts:48,73,123-152` | Canonicalise in parse, matching Postgres `numeric(p,s)` coercion: strip leading zeros; round excess fractional digits **half away from zero** to the declared scale (`1.234`→`1.23`, `1.235`→`1.24`, `-1.235`→`-1.24`); pad a short fraction to the scale; `-0`/`-0.00` → `0`/`0.00`; more integer digits than `p - s` refused with `X_INPUT_INVALID` (Postgres: numeric field overflow). Decimal-string arithmetic only, never `Number`. Parity cases for each of these | patch |
| e | a seed `upsert` never reports `'skipped'` for tables with generated ids, because a fresh uuid or `defaultNow()` enters the comparison | `packages/entity/src/seed.ts:294-299` | Leave the PK and any column the caller did not name (`!Object.hasOwn(values,p)`) out of `compared` | patch |
| f | `min`/`max` on `timestamptz` goes through a bare `::text`, then `new Date(text)`. That gives NaN for an offset with seconds, and year `0099` becomes 1999 | `packages/entity/src/aggregate-decode.ts:26-28`, `pg-sql.ts:443` | Select `extract(epoch from …) * 1000` (epoch ms, as `float8`) and decode with `new Date(ms)`. Not `at time zone 'UTC'`, which yields an offsetless `timestamp` that JS parses as local time. Test under `TZ=America/New_York` and `TZ=Asia/Tokyo`, with a year-`0099` row and a pre-1900 LMT row | patch |
| g | `jit-preload` on a page wider than 2000 fetches every id, then evicts most of them (suspected, perf) | `packages/entity/src/jit-preload.ts:229,269-271` | Pass `preload` only the ids the bucket keeps | patch |
| h | the keyset cursor stringifies the `id` tiebreak and `isAfterKey` compares it with `compareValues`, which falls to lexical order. With numeric ids tied on the sort key, page 2 loses rows (`"10" < "5"`) | `packages/query/src/source.ts:306`, `shape.ts:57` (`seekKeyOf`) | Carry the id's type through `serializeSortValue`/`reviveSortKey` (`SeekKey.id: unknown`) | patch |
| i | text `orderBy`/`gt`/`lt` compare UTF-16 code units in memory, while Postgres under `en_US.utf8` orders `'a' < 'B'` (suspected; may be accepted design) | `packages/entity/src/memory-match.ts:78`, `query/src/shape.ts:161` | Decide: refuse text range filters and orderBy the way `aggregate.ts:23` refuses text `min`/`max`, or document that PGlite/C collation is the parity target and pin `collate "C"` in generated text orderBy. Record the decision in `packages/entity/CLAUDE.md` | minor if refused |
| j | the live matcher's `same()` requires matching `typeof`, so int8 `5n` ≠ `5` (suspected) | `packages/query/src/shape.ts:201` | Reproduce. If real, compare numerically across bigint/number | patch |

## Steps
1. Create `packages/entity/src/write-parity.test.ts` rows for a, b, c, d and e, running each against memory and PGlite. PGlite runs in unit tests without Postgres; follow the existing `write-parity` shape.
2. Fix a–f in that order. a and b are the data-loss rows.
3. h: add a pagination test with integer ids tied on the sort key, first against `Builder.execute`, then the SQL path.
4. i and j: reproduce first. Record the decision in the package `CLAUDE.md`.

## Tests
- `bun test packages/entity/src packages/query/src`
- `TEST_DATABASE_URL=… bun test packages/entity/src/*.live.test.ts` (real Postgres for collation row i)

## Done when
- Each row has a parity test that failed before its fix.
- `.transition()` works on a `code`-keyed entity under both drivers.
- Paginating 3 rows with integer ids tied on `rank` returns all 3.
