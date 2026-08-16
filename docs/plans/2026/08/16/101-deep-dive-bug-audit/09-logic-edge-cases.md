# 09 — Logic errors and edge cases

> Part of [`overview.md`](overview.md). Depends on: none. Tiers: 0–3.

Defects that do not crash and are not security holes: the code runs, returns a value, and the value is
**wrong**. No other sweep catches these. 12 of the findings below carry an executed `bun -e`
reproduction against workspace source; the rest carry a `file:line` reasoning chain.

## Critical

- `packages/money/src/convert.ts:72` — `convert()` ignores the amount's own `scale`, reinterpreting a
  sub-cent amount at the currency's exponent. Line 72 uses `exponentOf(amount.currency)` where every
  other function uses `moneyScale(amount)`, and the result is minted with `money(converted, target)`
  — no scale — so the output silently claims the target currency's natural scale. Proven:

  ```
  convert(money(1_000_000,'USD',6) /* $1.00 in micros */, 'EUR', {rate:1})
    → { minor: 1000000, currency: 'EUR' }   // €10,000.00, expected €1.00
  convert(money(2,'USD',6), 'EUR', {rate:1})
    → { minor: 2, currency: 'EUR' }         // €0.02, expected €0.000002
  ```

  This is the exact failure `scale` was introduced to prevent (the `$0.00016` LLM-cost story quoted in
  `packages/schema/src/money-value.ts:34-37` and `packages/entity/src/type-pins.ts:283-286`). **Found
  independently by three agents.** Fix: `exponentOf(target) - moneyScale(amount)`, and mint at the
  source scale — or document that conversion narrows to the target's natural scale and round there
  deliberately.

- `packages/entity/src/columns.ts:245-251` + `packages/entity/src/pg-row.ts:76-77` — **the entity
  layer silently drops `MoneyValue.scale` on both write and read.** `parseMoney` rebuilds the value as
  `{ minor, currency }` with no `scale`; `bindValues` writes only `<p>_minor` and `<p>_currency`, and
  `columnsOf` (`pg-row.ts:18-21`) declares no third physical column. A scaled amount is stored as if
  it counted the currency's own minor units, and read back the same way. Proven:
  `money().$parse({ minor: 2, currency: 'USD', scale: 6 })` → `{ minor: 2, currency: 'USD' }` —
  $0.02, was $0.000002.

  The contradiction is explicit in the repo: `entity/src/type-pins.ts:262-289` asserts at compile time
  that `MoneyValue` has exactly `minor | currency | scale` and that entity's alias is *identical* to
  schema's, and `t.money` validates and preserves `scale`
  (`packages/schema/src/money-value.ts:111-115`). The type system, the wire schema and the money
  package all carry the field; only the layer that persists it throws it away, with no error. Fix:
  either add a third physical column (`<p>_scale smallint null`) through
  `columnsOf`/`bindValues`/`moneyOf`/`parseMoney`, **or** make `parseMoney` refuse a value whose scale
  differs from the currency's, with a coded error. A silent 10,000× reinterpretation is the one
  outcome that must not ship.

- `packages/query/src/pagination.ts:62` with `packages/core/src/cursor.ts:76` — **a `Date` sort key
  does not survive the cursor's JSON round-trip, so page 2 comes back empty.** `paginate()` puts the
  raw column values into `encodeCursor`, which does `JSON.stringify([scope, id, key])`; a `Date`
  becomes an ISO string, `decodeCursor` returns it as a string, and nothing revives it. `isAfterKey`
  (`source.ts:175`) then calls `compareValues(Date, string)`, which falls to the
  `String(left) < String(right)` branch (`shape.ts:143-145`) and compares `"1769904000000"` against
  `"2026-02-01T…"`. Proven with three rows ordered by `createdAt`, `first: 2`:

  ```
  page 1 = [a, b]
  seek with the in-memory key  → [c]     ✔
  seek with the decoded cursor → []      ✘
  ```

  A `bigint` sort key is worse: `encodeCursor` throws a bare
  `TypeError: JSON.stringify cannot serialize BigInt` — no `X_*` code, violating the
  never-throw-a-bare-`Error` rule. The sibling gets this right: `packages/entity/src/cursor.ts:72-93`
  has `serializeSortValue`/`reviveSortValue` keyed off the column kind precisely so the round trip is
  type-stable; `@ultimat3/query` has neither half. Fix: serialize/revive the way entity does. At
  minimum, `encodeCursor` must reject a non-JSON-safe key with `CursorInvalidError`.

## High

- `packages/query/src/shape.ts:142-145` — `compareValues` orders `bigint` (and mixed number/bigint)
  **lexicographically**: the numeric fast path is `typeof left === 'number' && typeof right ===
  'number'`, so a `bigint` falls to `String(left) < String(right)`. `bigint` is a first-class
  `ColumnKind` (the physical type of `<p>_minor`) and `count-by.ts:26-33` lists it as groupable, so
  these values do reach the comparator. Proven: `compareValues(9n, 10n)` → `1`;
  `compareValues(2, 10n)` → `1`; sorting yields `["10","100","9"]`. Postgres orders numerically, so
  the in-memory source, the live matcher and the seek fallback all disagree with the database on any
  bigint-ordered read. Fix: add a `bigint` branch to `normalize()` — the shape
  `packages/entity/src/count-by.ts:123-125` already uses.

- `packages/entity/src/expr.ts:124-131` — `matches()` drops the RegExp's flags, so the app predicate
  and the emitted `CHECK` disagree. `toSql` emits `~ ${literal(pattern.source)}` — `.source` only —
  while `holds` runs `pattern.test(value)` with flags intact. Proven:
  `c.slug.matches(/^[A-Z]+$/i)` → `holds({slug:'abc'})` is `true` (case-insensitive) while the SQL is
  `slug ~ '^[A-Z]+$'`, case-**sensitive**, rejecting `'abc'`. The file's header states "One
  declaration compiles to two enforcement points". `@ultimat3/schema` fixed this identical bug —
  `node.patternFlags` exists (`schema/src/node.ts:54-59`) and `json-schema.ts:85-91` states flags in
  prose rather than silently narrowing. Fix: translate `i` to Postgres' `~*`; refuse any other flag
  with a coded error naming it.

- `packages/schema/src/builder.ts:159-163` — `default(value)` hands every parse **the same object
  reference**. Proven:

  ```
  const s = t.object({ tags: t.array(t.string).default([]) });
  s.parse({}).tags === s.parse({}).tags   → true
  a.tags.push('leaked');  s.parse({})     → { tags: ['leaked'] }
  ```

  Every request that omits the field sees the previous request's mutation — cross-request data bleed
  through a schema default. Fix: `default()` takes `Out | (() => Out)` and calls the thunk per parse,
  or `structuredClone(fallback)` per parse for objects. The IR field `node.default` must keep the
  *declaration* for OpenAPI.

- `packages/schema/src/json-schema.ts:93-184` — `nullable` never reaches the JSON Schema. Full detail
  and the committed-spec evidence are in [`04-projection-contract.md`](04-projection-contract.md);
  recorded here because this sweep reached it independently, which is the third agent to do so.

- `packages/i18n/src/interpolate.ts:75` — the `one` plural branch has no `_other`/`_plural` fallback,
  and `Translator.has()` says the opposite. `if (category === 'one') return [\`${key}_one\`, key];`
  while every other category falls back through `_plural` and `_other` — but `translator.ts:73-77`
  answers `has()` true on `_other` **or** `_plural` **or** `_one`. Proven with catalog
  `{items_other, items_plural}`, locale `en`:

  ```
  t.has('items')            → true
  t('items', { count: 3 })  → "3 items"
  t('items', { count: 1 })  → "⟦items⟧"   ← loud miss for a key has() just confirmed
  ```

  Two functions in one package answering one question differently, and the miss lands in production
  copy. (Same line: the `other` category emits `items_other` twice — harmless, but it shows the list
  was never exercised.) Fix: give `one` the same fallback chain; de-duplicate with a `Set`.

- `packages/money/src/money.ts:83-85` — `fromDecimal`'s rounding path goes **through a float**, the
  one thing the package says it never does: `Number('0.4999…9')` collapses to exactly `0.5`, so
  `roundToInteger` sees a tie the exact decimal does not have. Proven:

  ```
  fromDecimal('1.0049999999999999999','EUR',{rounding:'half-up'})   → 101  (exact: 100)
  fromDecimal('1.0250000000000000001','EUR',{rounding:'half-even'}) → 102  (exact: 103)
  ```

  This is byte-for-byte the failure `rounding.ts:46-52` and `factor.ts:1-7` were written to eliminate
  for `multiply`/`divide`/`convert`. `roundRatio(numerator, denominator, mode)` already exists and is
  exact; `fromDecimal` is the one entry point never moved onto it — **and it is the entry point every
  user-typed price goes through.** Fix: build the exact fraction from the digit strings and call
  `roundRatio`.

## Medium

- `packages/time/src/business.ts:74-89` — `businessDaysBetween` depends on the **time of day**, and
  its header states the wrong interval. The header says `[from, to)`; the loop advances one *local
  day* keeping the wall-clock time, then breaks on `cursor.getTime() > end.getTime()`, so whether the
  final day counts depends on whether `to`'s clock time is at or after `from`'s — and `from`'s own day
  is never counted, making the real interval `(from, to]`. Proven (UTC, Sat/Sun weekend):
  `Mon 09:00 → Fri 10:00` = 4, `Mon 09:00 → Fri 08:00` = 3, same calendar span. Fix: compare local
  **dates**, not instants, and decide the interval out loud.

- `packages/entity/src/expr.ts:110-114` — `minLength` counts UTF-16 code units in JS and **code points
  in Postgres**: `holds` is `value.length >= length`; `toSql` emits `char_length(<col>) >= length`.
  Proven: `c.title.minLength(2).holds({title:'👍'})` is `true` while `char_length('👍')` is 1, so the
  CHECK rejects it — a write the framework's own invariant approved is rejected by the database as a
  raw constraint error, bypassing `X_INVARIANT_VIOLATED`. Fix: `[...value].length`.

- `packages/query/src/matcher.ts:77-79` — a row that moves past the end of a full window is
  re-inserted **inside** it, with no `refill`. The comment reads "A move keeps the window full, so it
  never needs a refill", but `insert()` computes `positionFor` over the `limit - 1` rows the client
  still holds, so the position can never reach `shape.limit` and the `position >= shape.limit` bail
  (`:89`) is unreachable on this path. Proven (`limit: 3`, `orderBy: rank asc`, window
  `[a:1,b:2,c:3]`, server also holds `d:4,e:5`): `update a → rank 99` emits
  `[{remove a@0},{add a@2}]`, so the client renders `[b:2, c:3, a:99]` where the true window is
  `[b:2, c:3, d:4]`. Fix: when the pre-move window was full and the new position lands at the tail of
  `without`, emit `refill` instead of `add` — only the server can answer the tail.

- `packages/time/src/cron-describe.ts:31-71` — `describeCron` ignores the seconds field entirely,
  though `parseCron` accepts 6 fields and populates `cron.seconds`. `*/10 * * * * *` (every ten
  seconds) renders as "every minute"; `30 0 3 * * *` renders identically to `0 3 * * *`. Fix: add a
  seconds phrase, or refuse a 6-field expression it cannot describe — a summary that is wrong is worse
  than one that declines.

- `packages/time/src/instant.ts:16-26,89` — `instant()`/`fromIso()` return an **aliased mutable
  `Date`** (`value as Instant` — the caller's own object, still `setTime()`-able after the brand is
  applied), and `export const EPOCH: Instant = new Date(0) as Instant` is one shared mutable object
  exported from a tier-1 package: any consumer calling `EPOCH.setUTCFullYear(…)` corrupts it for every
  other consumer in the process, permanently and silently. Fix: return a copy; make `EPOCH` a getter.

## Low

| Site | Defect |
|---|---|
| `packages/jobs/src/retry.ts:51` | `jitter` is the one retry option with no `DEFAULT_RETRY` fallback, while its own doc says "Equal jitter … by default". Masked for jobs declared through `job()`; bites direct callers of the exported `backoffDelayMs` |
| `packages/jobs/src/limits.ts:148-152` | `inFlight()` ignores `queue` whenever `tenantId` is present, so `{queue, tenantId}` answers "this tenant everywhere" |
| `packages/entity/src/cursor.ts:79` | comment contradicts the constant three lines above it ("`minor` is bigint" vs `MONEY_PARTS.minor = 'integer'`, which the file header explains at length) |
| `packages/jobs/src/steps.ts:303` | the one-argument `sleep(duration)` derives a name that collides on the second identical sleep, so `for (…) { await step.sleep('1h') }` fails with a duplicate-step error on iteration 2 |
| `packages/schema/src/validators.ts:66-70` | `min`/`max` on a string count UTF-16 code units but the message says "chars" — `t.string.max(1).parse('👍')` fails for a value a human reads as one character |
| `packages/time/src/schedule.ts:82-89` | a bad `slot.weekday` is reported as `X_TIMEZONE_INVALID`, naming a zone that is perfectly valid, with an unactionable `fix:` |
| `packages/query/src/stable.ts:17` | `NaN`, `Infinity`, `-Infinity` and JSON `null` all fingerprint as `null`; `-0` collides with `0` — two different query inputs sharing one cache entry |
| `packages/time/src/cron-parse.ts:143-149` | a wrapping range with a step restarts the stride phase at `min`: `23-3/2` → `[0,2,23]` where a continuing every-2-hours stride is `23,1,3` |
| `packages/cache/src/redis.ts:223` | the Redis tier rounds every TTL **up** to a whole second (`Math.ceil`), so a 1,001 ms lease is honoured as 2 s — favouring staleness, the opposite of what the jitter machinery protects. The LRU tier holds exact milliseconds |
| `packages/money/src/rounding.ts:26,32-42` | every mode returns `-0` for a negative value rounding to zero; it flows into `money(-0, …)`, where `JSON.stringify` writes `0` while `Object.is` and any keyed `Map` see a different value |
| `packages/money/src/convert.ts:104` | an identity conversion stamps the audit trail with the epoch (`options.at ?? new Date(0)`), while `ExchangeRate.at` is documented as "part of the audit trail, not decoration" |
| `packages/jobs/src/worker-fleet-slots.ts:51-52` | `concurrency: 0` makes a job permanently unrunnable rather than an error — `acquire` answers `false` forever with no log line |
| `packages/policy/src/grant-index.ts:62` | `actorPermissions()` returns the memoised internal array; `readonly string[]` is compile-time only, so a caller can `push` a grant into the per-actor authz cache for the life of that request |
| `packages/time/src/zones.ts:131-139` | `observesDst` probes with `setUTCMonth(+n)`, which rolls over at month end, so the twelve probes are not twelve distinct months. CONFIDENCE: low on impact — both offsets are still hit for a real DST zone — but it is a latent month-end bug in the package whose premise is that this class of bug is not allowed |

## Verified sound — do not "fix"

**The empty-array-filter classic is not present**: `matchesFilter`'s `'in'`
(`packages/query/src/shape.ts:98`) answers `false` for `[]`, and `filterClause`
(`packages/query/src/source.ts:104-112`) emits the `1 = 0` constant for both `in []` and a non-array
operand — in-memory and SQL agree. LRU and Redis tag invalidation agree (they *look* asymmetric;
`redis.set` joins a row-tagged value key to both buckets). The exact-fraction money path is sound
(`factorFraction`, `roundRatio`, `multiply`, `divide`, `allocateByRatios`/`weigh` are exact over
bigints; `BigInt('+21')` does not throw). Keyset SQL and in-memory seek agree on NULLs in both
directions, traced term by term. `countsFrom` is not off-by-one (drivers request `MAX_GROUPS + 1`).
`toZoned`'s millisecond extraction is correct for pre-1970 instants (`Math.floor`, not `trunc`).
`interpolate` uses `value === undefined`, not truthiness, so `0`/`false`/`''` render as themselves.
`parseAcceptLanguage` drops `q=0` per RFC 9110. `expandRoles` throws before `roleMap` is reassigned.
`publish()` in `query/src/cache.ts:81` evicts only its own in-flight promise. `recordSchema` refuses
prototype keys **and** builds on a null prototype. `sameSignature` is genuinely constant-time over
equal-length inputs.

## Tests

- One test per Critical, each asserting the *value*: a scaled `Money` survives convert; a scaled
  `Money` survives a write/read round-trip through both drivers; page 2 of a `Date`-ordered query
  returns the third row.
- A property test over `compareValues` asserting agreement with Postgres ordering for every
  `ColumnKind` — this is the general form of the bigint bug and of the NULL semantics already verified
  sound.
- `packages/schema/src/builder.test.ts` — two parses of a schema with an object default return
  distinct objects.
- `packages/i18n/src/translator.test.ts` — `has(key)` true implies `t(key, {count:1})` is not a loud
  miss, for every plural category.
- `packages/money/src/money.test.ts` — `fromDecimal` on the two proven inputs.

## Done when

- All three Criticals fixed; `MoneyValue.scale` either persists end-to-end or is refused at the
  boundary, with the choice recorded in `packages/entity/CLAUDE.md`.
- No public function returns an aliased mutable caller object or a shared default instance.
- `bun run verify` green.
