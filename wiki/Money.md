# Money

```ts
export interface Money {
  minor: number;
  currency: string;
}
```

Integer minor units + ISO-4217 alphabetic code. Never a float, never a `number` in a column, never a currency-less amount.

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
| `<name>_currency` | `char(3)` | uppercase ISO-4217. `NOT NULL`, `CHECK` against the currency table |

| Rejected storage | Why |
|---|---|
| `numeric(12,2)` | assumes exponent 2; wrong for JPY and KWD, and reads back as a string that becomes a float |
| `double precision` | see above |
| `jsonb` money object | not indexable, not sum-able, not constrainable |
| Minor units with no currency column | the amount is meaningless the day a second currency appears |

Entities declare a money field once and the generated migration emits both columns plus the check. See [Entities and migrations](Entities-And-Migrations).

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
| An unknown ISO code | throws `X_CURRENCY_UNKNOWN`; fix is `x money add-currency <CODE> --exponent <n>` |
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

The exponent table is data, not an assumption. `As of 2026-07`, ~54 codes.

| Currency | Exponent | `minor: 1000` means |
|---|---|---|
| `USD`, `EUR`, `GBP` | 2 | 10.00 |
| `JPY`, `KRW`, `VND`, `ISK`, `CLP`, `XOF` | 0 | 1000 |
| `KWD`, `BHD`, `JOD`, `OMR`, `TND` | 3 | 1.000 |

`exponentOf(currency)` and `scaleOf(currency)` derive from the table. A hardcoded `/ 100` is wrong in nine of the codes above.

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
| LLM cost accounting | per call, per tenant, per prompt version; reported by `x ai cache --json` and `budgets.report` |
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
| `X_CURRENCY_UNKNOWN` | code is not in the ISO-4217 table | `x money add-currency <CODE> --exponent <n>` |
| `X_CURRENCY_MISMATCH` | combining two currencies — an `X_INVARIANT`-class violation | `convert(...)` first, then combine |
| `X_ALLOCATION_INVALID` | non-positive part count, or ratios that are non-finite, negative, or all zero | pass valid ratios |
| `X_RATE_MISSING` | no rate registered for the pair | register a `RateProvider` covering it |

Full list: [Error codes](Error-Codes).

## Rules

- `Money = { minor: number; currency: string }`. No other money type exists.
- Never a float. Never a bare `number` for an amount.
- Two columns: integer minor + `char(3)` currency.
- Same currency or throw. No implicit conversion, ever.
- A non-integer multiplier requires an explicit rounding mode.
- `allocate` distributes the remainder; the parts always sum to the whole.
- Exponents come from the currency table, never from `100`.
- Format at the edge with an explicit locale and currency → [I18n](I18n).
