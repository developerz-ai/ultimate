# Money

```ts
export interface Money {
  readonly minor: number;
  readonly currency: string;
}
```

Integer minor units + a three-letter uppercase code — the 53 ISO-4217 rows the framework ships, plus whatever the app registers. Never a float, never a `number` in a column, never a currency-less amount.

**One declaration, three names.** `@ultimat3/schema`'s `MoneyValue` is the type; `@ultimat3/money`'s `Money` and `@ultimat3/entity`'s `MoneyValue` are aliases of it, not restatements of its shape. It lives at tier 0 because that is the only tier every package may import. A row a `money()` column decodes therefore *is* a `Money` — pass it to `add()`, `formatMoney()` or `<Money>` with no conversion and no cast.

`minor` is a `number`, not a `bigint`, because money is projected onto every wire this framework generates: `JSON.stringify` refuses a bigint, and `t.money` is also the OpenAPI contract. The column is still `bigint` — see the range rule under [Storage](#storage).

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

Two columns per amount. No JSON blob, no `numeric` amount, no float.

| Column | Type | Notes |
|---|---|---|
| `<name>_minor` | `bigint` (`integer` under 2^31 minor units) | the integer count. `NOT NULL` |
| `<name>_currency` | `char(3)` | uppercase three-letter code. `NOT NULL`, `CHECK (<name>_currency ~ '^[A-Z]{3}$')` — the shape, not the table |

| Rejected storage | Why |
|---|---|
| `numeric(12,2)` | assumes exponent 2; wrong for JPY and KWD, and reads back as a string that becomes a float |
| `double precision` | see above |
| `jsonb` money object | not indexable, not sum-able, not constrainable |
| Minor units with no currency column | the amount is meaningless the day a second currency appears |

Entities declare a money field once and the generated migration emits both columns plus the check. See [Entities and migrations](Entities-And-Migrations).

**The column is wider than the value, and the gap is a refusal.** `bigint` holds more than a JS number does, so a `<name>_minor` past ±2^53 — written by a psql session, a backfill, another service, never by this framework — is refused when it is read (`X_INVARIANT_VIOLATED`, naming the value). It is never rounded into the row, and never carried as a `bigint` that would crash the response three layers later. `@ultimat3/realtime` refuses the identical value for the identical reason, so the two readers of one column agree.

A **writer** may still hand a `bigint` — `MoneyInput` is `{ minor: bigint | number; currency: string }`, so a minor unit read straight off a `bigint` column reaches an insert with no conversion at the call site. Both drivers narrow it to the value type before storing, so what a row holds never depends on which one you built.

## Operations

Allowed, total, and typed. `As of 2026-08` the package ships the currency table, the rounding modes, the error codes, and the arithmetic surface below.

| Operation | Signature | Behavior |
|---|---|---|
| add | `add(a: Money, b: Money): Money` | same currency only |
| subtract | `subtract(a: Money, b: Money): Money` | same currency only; negative results are legal (refunds, credits) |
| multiply by integer | `multiply(m: Money, factor: number): Money` | exact when `factor` is an integer |
| multiply with rounding | `multiply(m: Money, factor: number, mode: RoundingMode): Money` | required for a non-integer factor (tax rate, discount) |
| negate | `negate(m: Money): Money` | |
| absolute | `abs(m: Money): Money` | |
| allocate by ratios | `allocate(m: Money, ratios: readonly number[]): Money[]` | distributes the remainder one minor unit at a time, largest ratio first. Sum always equals the input, exactly |
| split into n | `split(m: Money, parts: number): Money[]` | `allocate` with equal ratios |
| compare | `compare(a: Money, b: Money): -1 \| 0 \| 1` | same currency only |
| predicates | `isZero`, `isNegative`, `equals` | |
| sum | `sum(items: readonly Money[]): Money` | empty array requires an explicit currency |
| from decimal string | `fromDecimal(value: string, currency: string, opts?)` | parses `'19.99'` using the currency's exponent |
| to decimal string | `toDecimal(m: Money): string` | for exports and APIs, not for display |
| convert | `convert(m: Money, to: string, rate: Rate): Money` | explicit rate object, explicit rounding mode |

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

Explicit, always. Tax, interest, and VAT rules each name one in law.

| Mode | Rule | Use |
|---|---|---|
| `half-up` | 0.5 away from zero | the commercial default most invoicing rules specify. Package default |
| `half-even` | 0.5 to nearest even (banker's) | ISO 80000-1; avoids upward drift over many rows |
| `down` | truncate toward zero | never overcharge |
| `up` | away from zero | never undercharge |

`roundToInteger(value, mode)` rounds fractional minor units; `roundToDigits(value, digits, mode)` is used when a decimal string is more precise than the currency's minor unit.

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
