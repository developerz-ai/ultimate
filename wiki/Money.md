# Money

```ts
export interface Money {
  readonly minor: number;
  readonly currency: string;
  /** Decimal places `minor` counts, when they are not the currency's own. */
  readonly scale?: number;
}
```

Integer minor units + a three-letter uppercase code — the ISO-4217 rows the framework ships (**53**, `As of 2026-08` — [Currency exponents](#currency-exponents)), plus whatever the app registers. Never a float, never a `number` in a column, never a currency-less amount.

## The ceiling: 9,007,199,254,740,991 minor units

`minor` is a JavaScript `number`, so the largest amount a `Money` can carry is **`Number.MAX_SAFE_INTEGER` — 9,007,199,254,740,991 minor units**. In USD cents that is roughly $90 trillion; in JPY, ¥9 quadrillion.

**Past it, refused. Never truncated, never widened, never rounded into the row.** `money(2 ** 53, 'USD')` throws `X_MONEY_NOT_INTEGER`, and `t.money` fails the same value at the HTTP boundary with the field path attached — the same refusal twice, so a body that would have failed at the row write fails at the door instead.

| Where the refusal fires | Code |
|---|---|
| a value built in code — `money()`, arithmetic, `fromDecimal` | `X_MONEY_NOT_INTEGER` |
| a value off the wire — `t.money`, and therefore the OpenAPI contract | the boundary's own issue, with the field path |
| a value read back off a `bigint` column past ±2^53 | `X_INVARIANT_VIOLATED`, naming the value |

That is deliberate. `minor` is not a `bigint` because money is projected onto every wire this framework generates: `JSON.stringify` refuses a bigint, and `t.money` **is** the OpenAPI contract. A silently-widened amount that crashes the response three layers away is worse than a loud refusal at the boundary. Migrating an app with amount columns that might exceed it: [Migrating an existing app](Migrating-An-Existing-App#1-money--magnitude) carries the audit query.

## `scale` — sub-minor precision, without a second money type

`scale` names the decimal places `minor` counts, **when they are not the currency's own**. Absent — the shape every value and every row already had — means the currency's natural minor unit: 2 for USD, 0 for JPY, 3 for KWD.

```ts
money(1999, 'USD');            // $19.99      — no scale key, the currency's own minor unit
money(2, 'USD', 6);            // $0.000002   — minor counts millionths
toDecimalString(money(2, 'USD', 6));   // '0.000002'
```

| Rule | Detail |
|---|---|
| Range | `0 … MAX_MONEY_SCALE`, and **`MAX_MONEY_SCALE` is 15**. 10^15 is the last power of ten that is itself a safe integer, so a finer scale could not name its own unit inside the range `minor` is already checked against |
| Absent ≠ `0` | absent is "the currency's own"; `0` is "whole units". Collapsing them is a 100x reinterpretation of every ordinary price, so the key is carried only when it was sent and a value at the currency's own scale round-trips byte for byte |
| It exists because a cents-only value could not name a sub-cent amount at all | the one place that needed one — a model call costing $0.00016 — rounded up to a whole cent and reported **62x** the real spend. The alternative was a second money type, which is the axiom-1 violation the one declaration exists to prevent |
| A legacy `numeric(19,4)` fits | four decimals on a two-decimal currency is `scale: 4` — the value stays exact and stays one `Money` |
| Arithmetic meets at the **finer** scale | which is exact for both operands; the coarser one widens. Widening never throws; narrowing is `rescale()`, which takes a mode out loud |
| A comparison widens as `bigint` | so `MAX_SAFE_INTEGER` cents restated in micros can be compared without being storable |
| An out-of-range scale is `X_MONEY_SCALE_INVALID` | a scale that names no decimal place is a data bug, not a formatting preference |

`fromDecimal('12.9999', 'USD', { scale: 4 })` keeps every digit. Without the `scale`, more fraction digits than the currency has is `X_MONEY_NOT_INTEGER`, and its `fix:` offers the exact `scale` that would keep them.

**One declaration, three names.** `@ultimat3/schema`'s `MoneyValue` is the type; `@ultimat3/money`'s `Money` and `@ultimat3/entity`'s `MoneyValue` are aliases of it, not restatements of its shape. It lives at tier 0 because that is the only tier every package may import. A row a `money()` column decodes therefore *is* a `Money` — pass it to `add()`, `formatMoney()` or `<Money>` with no conversion and no cast.

The **column** is still `bigint`, wider than the value it holds — see the range rule under [Storage](#storage).

`{ minor: 1999, currency: 'USD' }` is $19.99. `{ minor: 1999, currency: 'JPY' }` is ¥1999. The exponent comes from the currency table, never from an assumed `/ 100`.

## Why not a float

| Float behavior | Consequence |
|---|---|
| `0.1 + 0.2 === 0.30000000000000004` | a ledger that does not balance |
| Binary fractions cannot represent cents exactly | rounding drift that grows with row count |
| No currency attached | `total = subtotal + shipping` compiles across USD and EUR |
| `Math.round` mode is unspecified in law | tax rules name `half-up` or `half-even` explicitly; whichever `Math.round` does is not an answer |

An integer count of minor units is exact, and the currency travels with it so a mismatch is catchable.

## Storage

**Three columns per amount.** No JSON blob, no `numeric` amount, no float.

| Column | Type | Notes |
|---|---|---|
| `<name>_minor` | `bigint` (`integer` under 2^31 minor units) | the integer count. `NOT NULL` |
| `<name>_currency` | `char(3)` | uppercase three-letter code. `NOT NULL`, `CHECK (<name>_currency ~ '^[A-Z]{3}$')` — the shape, not the table |
| `<name>_scale` | `integer`, **nullable** | the value's own `scale`, or `NULL` for "the currency's own minor unit". `CHECK (… is null or (… >= 0 and … <= 15))`. `NULL` decodes to an **absent key**, never to `0` — a `0` written here would claim whole units, a 100x reinterpretation of every ordinary price. Nullable on purpose: a `NOT NULL` would demand a scale on every value that has none, which is every row written before the column existed |

| Rejected storage | Why |
|---|---|
| `numeric(12,2)` | assumes exponent 2; wrong for JPY and KWD, and reads back as a string that becomes a float |
| `double precision` | see above |
| `jsonb` money object | not indexable, not sum-able, not constrainable |
| Minor units with no currency column | the amount is meaningless the day a second currency appears |

Entities declare a money field once and the generated migration emits all three columns plus the checks. See [Entities and migrations](Entities-And-Migrations).

**A table this framework did not create names its own columns.** `money({ columns: … })` maps the three onto what is already there, merged per part over the `<name>_minor` / `<name>_currency` / `<name>_scale` defaults — so a legacy `amount_cents` beside a `currency` is two words, not three:

```ts
total: money({ columns: { minor: 'amount_cents', currency: 'currency', scale: null } }),
```

`scale: null` says the table has no scale column at all. What that costs is that every amount is then at the currency's own minor unit — which is exactly what an absent scale already meant, so it costs no correctness. Adopting a live schema: [Migrating an existing app](Migrating-An-Existing-App).

**An amount column with no currency column beside it is not adoptable as `money()`, and should not be.** A `Money` is an amount *and* a currency by construction; a single implied currency is the bug the type exists to prevent, and a framework that guessed one would guess on every row. Declare such a column as `decimal({ precision, scale })` and carry the currency in your own column.

`<name>_scale` is **not addressable** as a predicate or a sort key. A scale says which units `minor` counts, so ordering or filtering by it compares two different questions.

**The column is wider than the value, and the gap is a refusal.** `bigint` holds more than a JS number does, so a `<name>_minor` past ±2^53 — written by a psql session, a backfill, another service, never by this framework — is refused when it is read (`X_INVARIANT_VIOLATED`, naming the value). It is never rounded into the row, and never carried as a `bigint` that would crash the response three layers later. `@ultimat3/realtime` refuses the identical value for the identical reason, so the two readers of one column agree.

A **writer** may still hand a `bigint` — `MoneyInput` is `{ minor: bigint | number; currency: string }`, so a minor unit read straight off a `bigint` column reaches an insert with no conversion at the call site. Both drivers narrow it to the value type before storing, so what a row holds never depends on which one you built.

## Operations

Allowed, total, and typed. `As of 2026-08` the package ships the currency table, the rounding modes, the error codes, and the arithmetic surface below.

| Operation | Signature | Behavior |
|---|---|---|
| add | `add(a: Money, b: Money): Money` | same currency only; the operands meet at the finer of their two scales, which is exact for both |
| subtract | `subtract(a: Money, b: Money): Money` | same currency only; negative results are legal (refunds, credits) |
| multiply | `multiply(m: Money, factor: number, mode?: RoundingMode): Money` | exact for an integer factor. For a fraction, `mode` defaults to `DEFAULT_ROUNDING` — see [Rounding modes](#rounding-modes). The scale is taken as the exact fraction the factor's decimal spelling names, never as a float product |
| divide | `divide(m: Money, divisor: number, mode?: RoundingMode): Money` | a single share; the remainder is lost by design. `divisor: 0` is `X_ALLOCATION_INVALID` |
| negate | `negate(m: Money): Money` | |
| absolute | `absolute(m: Money): Money` | |
| allocate by ratios | `allocate(m, ratios)` · `allocateByRatios` · `allocateByPercentages` | distributes the remainder one minor unit at a time, largest ratio first. Sum always equals the input, exactly |
| compare | `compare(a: Money, b: Money): -1 \| 0 \| 1` | same currency only; widens as `bigint`, so it never throws on a value it could not store |
| predicates | `isZero`, `isNegative`, `isPositive`, `equals`, `lessThan`, `greaterThan`, `min`, `max` | |
| sum | `sum(items: readonly Money[], currency?: string): Money` | empty array requires an explicit currency |
| from decimal string | `fromDecimal(value, currency, { scale?, rounding? })` | parses `'19.99'` at the currency's exponent, or at `scale`. More fraction digits than the scale and no `rounding` is `X_MONEY_NOT_INTEGER` |
| to decimal string | `toDecimalString(m: Money): string` | for exports and APIs, not for display. `toDecimalNumber` for the lossy `number` |
| restate at another scale | `rescale(m, scale, mode?)` | widening is always exact. Narrowing needs `mode` **only when it is inexact** — nothing being decided means nothing to declare; an inexact narrowing with no mode is `X_MONEY_NOT_INTEGER`, which is literally what it would produce |
| convert | `convert(m, to, rate, options?): ConvertedMoney` | explicit rate object. Returns `{ amount, source, rate, at, provider? }` — the original is never overwritten, so a finance audit can reproduce every converted amount |

### Rejected

| Attempt | Result |
|---|---|
| `add({ minor, currency: 'USD' }, { minor, currency: 'EUR' })` | throws `X_INVARIANT` (`X_CURRENCY_MISMATCH`) — two currencies are not one number |
| `multiply(m, 0.0825)` with no rounding mode | throws — the caller must name the mode the tax rule names |
| `{ minor: 19.99, currency: 'USD' }` | throws `X_MONEY_NOT_INTEGER`; fix names `fromDecimal` |
| `fromDecimal('19.999', 'USD')` with no `rounding` | throws — more fraction digits than USD has minor units |
| `convert(m, 'EUR')` with no rate | throws `X_RATE_MISSING`. There is no default rate provider, because a wrong rate is worse than a missing one |
| A code this process does not know | throws `X_CURRENCY_UNKNOWN` — use one `currencyCodes()` lists, or add it with `registerCurrency({ code, exponent, name })` |
| `allocate(m, [0, 0])` or a negative ratio | throws `X_ALLOCATION_INVALID` |

Total across a currency boundary requires a conversion first. Silent coercion is how a marketplace bills in the wrong currency for a quarter.

## Rounding modes

**`DEFAULT_ROUNDING` is `'half-up'`.** Four modes, `ROUNDING_MODES` in declaration order:

| Mode | Rule | Use |
|---|---|---|
| **`half-up`** | 0.5 **away from zero** | the commercial default most invoicing rules specify. **The package default** |
| `half-even` | 0.5 to the nearest even (banker's) | ISO 80000-1; avoids upward drift over many rows |
| `down` | truncate toward zero | never overcharge |
| `up` | away from zero | never undercharge |

`roundToInteger(value, mode)` rounds fractional minor units; `roundToDigits(value, digits, mode)` is used when a decimal string is more precise than the currency's minor unit; `roundRatio(numerator, denominator, mode)` rounds an exact `bigint` fraction, which is what `multiply`, `divide`, `convert` and `fromDecimal` all use. A float product can only judge a value IEEE-754 has already moved — `100 * 1.005` is `100.49999999999999`, so `half-up` would answer 100 where the exact 100.5 owes 101, charging a 0.5% fee on €1.00 as nothing.

`-0` is never produced: an amount rounding to nothing stays `0`, because `JSON.stringify` writes `-0` as `0` while `Object.is` and any keyed `Map` see a different value.

### Changing rounding mode shifts every tie by one minor unit

A tie — an exact `.5` fractional minor unit — is where the modes disagree, and they disagree by exactly one minor unit every time. Under `half-up` the shift is **systematic** (always away from zero); under `half-even` it is **balanced** (half the ties go each way). That is why the two diverge with row count instead of cancelling, and why a migrating app that silently changes mode moves a reconciled ledger.

```ts
import { money, multiply } from '@ultimat3/money';

const one = money(100, 'USD');                  // $1.00

multiply(one, 0.125);                           // { minor: 13, currency: 'USD' } — the default, half-up
multiply(one, 0.125, 'half-up');                // { minor: 13, … }   $0.13
multiply(one, 0.125, 'half-even');              // { minor: 12, … }   $0.12  — 12 is even
multiply(one, 0.125, 'down');                   // { minor: 12, … }
multiply(one, 0.125, 'up');                     // { minor: 13, … }
```

12.5 minor units, four answers. One cent per tie, in one direction, over however many rows tie.

### What other stacks default to

`As of 2026-08`, and each is configurable — check what your app actually set, not what its ecosystem defaults to.

| Stack | Default rounding | vs Ultimate |
|---|---|---|
| **Ultimate** — `DEFAULT_ROUNDING` | `half-up` (away from zero) | — |
| Ruby, the `money` gem that `money-rails` wraps — `Money.rounding_mode` | `ROUND_HALF_EVEN` (banker's) | **different.** A tie that was $0.12 becomes $0.13 |
| Python, `decimal.Decimal` — the default context's `rounding` | `ROUND_HALF_EVEN` | **different**, same direction. `ROUND_HALF_UP` in Python is opt-in per `quantize()` call, never the default |
| JavaScript `Math.round` | half toward **+∞**, not away from zero | differs on **negatives**: `Math.round(-2.5)` is `-2`, `half-up` gives `-3`. This is one reason there is no `Math.round` anywhere in `@ultimat3/money` |

**Migrating, do this in order:**

| # | Step |
|---|---|
| 1 | Read the legacy app's configured mode, not its ecosystem default |
| 2 | If it is `half-even`, pass `'half-even'` explicitly at every `multiply`/`divide`/`convert`/`fromDecimal` call site that touches money the legacy app also computed |
| 3 | Reconcile a sample before cutover: recompute one period's line items both ways and diff the totals. The difference is one minor unit per tie, so a non-zero diff tells you exactly how many ties there were |
| 4 | Whichever you choose, name it. The tax rule names a mode in law, and whichever one a default happens to implement is not an answer |

A shift of ±1 minor unit is invisible on one invoice and is a reconciliation failure across millions of rows.

## Currency exponents

The exponent table is data, not an assumption. `As of 2026-08` it ships **53 ISO-4217 rows** ([`packages/money/src/currency.ts:21`](https://github.com/developerz-ai/ultimate/blob/main/packages/money/src/currency.ts)).

| Currency | Exponent | `minor: 1000` means |
|---|---|---|
| `USD`, `EUR`, `GBP` | 2 | 10.00 |
| `JPY`, `KRW`, `VND`, `ISK`, `CLP`, `XOF` | 0 | 1000 |
| `KWD`, `BHD`, `JOD`, `OMR`, `TND` | 3 | 1.000 |

`exponentOf(currency)` and `scaleOf(currency)` derive from the table. A hardcoded `/ 100` is wrong in nine of the codes above.

## Registering a currency

`As of 2026-08` the table is open, and it is opened by a call — not by config, not by a fork. 53 of roughly 180 ISO codes is a *convention*, and axiom 8 says an app encodes its own by calling a function.

```ts
import { money, registerCurrency, toDecimalString } from '@ultimat3/money';

// Once at boot, before any XBT amount is built.
registerCurrency({ code: 'XBT', exponent: 8, name: 'Bitcoin' });

const dust = money(1, 'XBT');
toDecimalString(dust); // '0.00000001'
```

A local currency, a scrip, a loyalty point, a token — anything the shipped rows do not carry.

| Rule | Detail |
|---|---|
| Refused, never defaulted | no exponent is guessable, so a bad declaration throws `X_CURRENCY_INVALID` rather than assuming 2 — a silent 2 reads `1.23456789 XBT` as `1.23` and shifts a stored `minor` by a power of ten |
| One code, one declaration | a second, *different* declaration of a code already in force throws `X_CURRENCY_REDEFINED`. An identical one returns the row in force, so a module imported twice is not a crash |
| A shipped ISO row is closed | `registerCurrency({ code: 'USD', exponent: 3, … })` throws `X_CURRENCY_REDEFINED`; registrations live beside `CURRENCIES`, never over it |
| Before the first amount | `money()`, `fromDecimal()` and every arithmetic call resolve the exponent at the call, so an amount built before the registration throws `X_CURRENCY_UNKNOWN` |
| Per process, not per row | a registration is in-memory. Every process that reads an amount in that currency must make the same call — the DB `CHECK` is `^[A-Z]{3}$`, so the row is already writable without it |

| Enumeration | Answers |
|---|---|
| `CURRENCIES` | the 53 rows this package ships. A constant, the same in every process |
| `currencyCodes()` | every code *this process* accepts, registrations included, sorted. The list `X_CURRENCY_UNKNOWN`'s fix names |
| `isValidCurrency(code)` | whether this process accepts it, without throwing |

### Why the table opened

Three layers already treated the currency set as open, and only arithmetic disagreed. All three now read one declaration — `CURRENCY_CODE_PATTERN = '^[A-Z]{3}$'` in `packages/schema/src/money-value.ts`.

| Layer | What it accepts | Where |
|---|---|---|
| the boundary | `isCurrencyCode` in `moneySchema` | `@ultimat3/schema`, `money-value.ts` |
| storage | `parseCurrency`, and the Postgres `CHECK` `currencyCheck()` emits | `@ultimat3/entity`, `columns.ts` |
| the published contract | `currency: { type: 'string', pattern: … }` in the generated OpenAPI | `@ultimat3/schema`, `json-schema.ts` |

So an app could already take `GHS` over HTTP, validate it, write it to Postgres and read it back — and `add()` was the only thing that refused it. The set was never closed; one package disagreed with the boundary, the storage layer and the contract it publishes. `CurrencyCode` is `string`, not a union, and the table had zero consumers outside `packages/money/` — nothing depended on it being total.

The pattern stays inside the syntax ECMAScript, JSON Schema and POSIX ERE spell identically. A `\d`, a lookahead or a non-greedy quantifier would make the Postgres `CHECK` stop meaning what `isCurrencyCode` means, and a real server is the first thing that would say so.

## Formatting

Edge only — a route or a component. Never in a service, repo, or job.

```ts
import { formatMoney } from '@ultimat3/money';
```

| Rule | Detail |
|---|---|
| Engine | `Intl.NumberFormat` with `style: 'currency'` |
| Locale | explicit, from the request context. Never the process default |
| Currency | explicit, from the `Money` value. Never a template-literal `$` |
| Digits | `minimumFractionDigits` / `maximumFractionDigits` from the currency exponent |
| Formatter cache | one per (locale, currency, options) — constructing per row is measurable |
| Never | string concatenation, `toFixed(2)`, a hand-written thousands separator |

`toDecimal` is for machine consumers (CSV, API payloads, accounting exports). `formatMoney` is for humans. They are not interchangeable.

## Where money appears in the framework

| Site | Shape |
|---|---|
| LLM budgets | `budget: { tokensIn: 8000, costPerCall: { minor: 5, currency: 'USD' } }` — exceeding it throws before spending |
| LLM cost accounting | per call, per tenant, per prompt version; reported by `budgets.report`. `x ai cache --json` is **planned** and exits `X_NOT_IMPLEMENTED`; `x test eval --json` is the shipped command it points at |
| Job cost accounting | per job run and per step, so an expensive retry loop is visible in the queue view |
| Admin columns | a money column renders as a right-aligned formatted amount with the currency code; the raw minor value is shown on hover |
| OTel span attributes | `cost.minor` + `cost.currency` as separate attributes, never a formatted string |

```ts
export const summarize = llm({
  model: 'claude-sonnet-4-5',
  input:  t.object({ postId: t.uuid }),
  output: t.object({ summary: t.string, tags: t.string.array() }),
  prompt: summarizePrompt,                       // versioned artifact
  cache:  { semantic: { threshold: 0.97, ttl: '7d' } },
  budget: { tokensIn: 8000, costPerCall: { minor: 5, currency: 'USD' } },
  policy: can('post:read'),
});
```

See [MCP and AI](MCP-And-AI).

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_MONEY_NOT_INTEGER` | `minor` is not a safe integer, or a decimal string is more precise than the currency | `fromDecimal(...)`, or pass an explicit rounding mode |
| `X_CURRENCY_UNKNOWN` | the code is neither a shipped ISO row nor registered by this process | pick one `currencyCodes()` lists, or declare it at boot with `registerCurrency({ code, exponent, name })` |
| `X_CURRENCY_MISMATCH` | combining two currencies — an `X_INVARIANT`-class violation | `convert(...)` first, then combine |
| `X_CURRENCY_INVALID` | a `registerCurrency` declaration that cannot become a currency — bad code shape, an exponent outside `0…15`, or an empty name | fix the declaration: three A–Z letters, a whole exponent, a non-empty name |
| `X_CURRENCY_REDEFINED` | one code registered twice with different meanings | keep one `registerCurrency` call and delete the other |
| `X_ALLOCATION_INVALID` | non-positive part count, or ratios that are non-finite, negative, or all zero | pass valid ratios |
| `X_RATE_MISSING` | no rate registered for the pair | register a `RateProvider` covering it |

Full list: [Error codes](Error-Codes).

## Rules

- `Money = { readonly minor: number; readonly currency: string }`. No other money type exists — `MoneyValue` in `@ultimat3/schema` and in `@ultimat3/entity` is the same declaration under another name.
- Never a float. Never a bare `number` for an amount. Never a `bigint` on a row.
- Two columns: integer minor + `char(3)` currency. A stored minor unit past ±2^53 is refused on read, never rounded.
- Same currency or throw. No implicit conversion, ever.
- A non-integer multiplier requires an explicit rounding mode.
- `allocate` distributes the remainder; the parts always sum to the whole.
- Exponents come from the currency table, never from `100`.
- A currency the shipped rows lack is `registerCurrency({ code, exponent, name })` at boot, never a fork of the table.
- Format at the edge with an explicit locale and currency → [I18n](I18n).
