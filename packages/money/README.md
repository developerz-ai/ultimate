# 💶 @ultimat3/money

**Golden rule: integer minor units, currency always attached, `Intl` at the edge.**
`0.1 + 0.2 !== 0.3`, so no amount is ever a float. `Money` is `{ readonly minor, readonly currency }`
— the two travel together, and arithmetic across two currencies throws instead of guessing.

`Money` **is** `@ultimat3/schema`'s `MoneyValue`, and so is `@ultimat3/entity`'s: one declaration
at tier 0, aliased twice, never restated. A row a `money()` column decodes is therefore a `Money`
already — `add(row.price, shipping)` and `formatMoney(row.price, locale)` take it with no cast.
`minor` is a `number` because money is projected onto every wire the framework generates and
`JSON.stringify` refuses a bigint; the `bigint` column that backs it refuses a value past ±2^53 on
read rather than rounding it. → [Money](https://github.com/developerz-ai/ultimate/wiki/Money)

| Concern | Store | Format |
|---|---|---|
| Amount | integer minor units (`1299`) | `Intl.NumberFormat`, `style: 'currency'` |
| Currency | ISO-4217 code (`'EUR'`) | fraction digits derived from its exponent |
| Scale | only when finer than the currency's (`scale: 6`) | `10 ** moneyScale(amount)` — never a literal `/ 100` |
| FX rate | explicit argument + timestamp | recorded on the converted value |

## Use

```ts
import { add, allocate, formatMoney, fromDecimal, money } from '@ultimat3/money';

const price = fromDecimal('12.99', 'EUR');   // { minor: 1299, currency: 'EUR' }
const total = add(price, money(500, 'EUR')); // 1799
formatMoney(total, 'de-DE');                 // "17,99 €"
formatMoney(money(1200, 'JPY'), 'en-US');    // "¥1,200"  — 0 decimals
formatMoney(money(1234, 'KWD'), 'en-US');    // "KWD 1.234" — 3 decimals
add(price, money(500, 'USD'));               // throws X_CURRENCY_MISMATCH
```

## Minor units are not always cents

`exponentOf()` is the single source of truth: USD/EUR 2, JPY/KRW/VND/ISK 0, KWD/BHD/OMR 3.
`fromDecimal` scales by it (`'1.234'` KWD → 1234), `toDecimalString` reverses it, and
`formatMoney` sets the fraction digits from it. Hardcoding `/ 100` is a JPY bug and a KWD bug.

## Sub-cent amounts carry a scale

`money(2, 'USD', 6)` is $0.000002 — `minor` counting 10⁻⁶ instead of the currency's own 10⁻².
A value that names no scale means the currency's, which is every amount that already exists, so
nothing about `{ minor, currency }` changes: same shape, same JSON, same columns.

```ts
moneyScale(money(1299, 'EUR'));              // 2 — the currency's own
moneyScale(money(2, 'USD', 6));              // 6
rescale(money(80, 'USD'), 8);                // $0.80 as 80,000,000 hundred-millionths
rescale(money(1_234_567, 'USD', 6), 2);      // throws X_MONEY_NOT_INTEGER — digits would go
rescale(money(1_234_567, 'USD', 6), 2, 'half-up');  // 123¢, the loss named at the call
fromDecimal('0.000002', 'USD', { scale: 6 });
add(money(1, 'USD'), money(2, 'USD', 6));    // meets at scale 6: 10002, nothing lost
```

Arithmetic normalises to the *finer* of two scales, never the coarser — adding a sub-cent fee to
a cent cannot round the fee away. `compare` and `equals` read the value rather than the encoding,
so 1299 EUR and 12,990,000 EUR at scale 6 are one amount. `multiply`, `divide`, `negate` and
`allocate` keep the scale they were handed. Widening is exact and free; narrowing needs a
`RoundingMode` at the call site, exactly as excess precision does in `fromDecimal`.

It exists because whole cents could not name the cost of a model call: $0.0002 rounded up to 1¢
is ~50x, and a budget built on that number is fiction. The alternative was a second money type.

## Allocation

`allocate(money(100, 'USD'), 3)` → `34, 33, 33`. Largest-remainder split: floor every part,
then hand out the leftover units one at a time, biggest fractional remainder first.
`round(100 / 3)` either loses a cent or invents one, and an invoice that does that fails
reconciliation forever. `allocateByRatios` does the same for revenue shares and line splits.

## Rounding is never implicit

`multiply(price, 0.19, 'half-up')` — the mode is an argument because tax and interest rules
name one in law. `half-up`, `half-even` (banker's), `down`, `up`. The default is `half-up`
and it is stated, not inherited from `Math.round`.

## Conversion

No default rate provider ships. `convert(amount, to, rate)` takes the rate explicitly and
returns the source amount, the rate, and its timestamp alongside the result — a finance
audit has to be able to reproduce the number. Implement `RateProvider` for a live feed;
`fixedRateProvider()` covers tests, seeds and manually agreed invoice rates.

A rate may also carry `ratio` — the exact `Fraction` its `rate` approximates — and `convert`
scales by that when it is there. It is how a derived direction stays exact: a table naming
`USD/EUR: 0.92` names 23/25, so `fixedRateProvider` answers EUR→USD with 25/23 rather than the
double `1 / 0.92`, whose own decimal spelling rounds a large amount one minor unit low. `rate`
stays the readable number the audit trail records.

## Errors

| Code | When |
|---|---|
| `X_MONEY_NOT_INTEGER` | fractional minor units, a decimal string more precise than the scale, or a `rescale` that would drop a digit with no mode named |
| `X_MONEY_SCALE_INVALID` | a scale that is not a whole number of decimal places in 0…15 |
| `X_CURRENCY_UNKNOWN` | code not in the ISO-4217 table |
| `X_CURRENCY_MISMATCH` | arithmetic across two currencies |
| `X_ALLOCATION_INVALID` | bad part count, empty/negative/all-zero ratios, percentages ≠ 100 |
| `X_RATE_MISSING` | no rate for the pair — never assumes parity |

## Why it exists

Every money bug in production is one of three things: a float, a missing currency, or a
lost cent in a split. This package makes all three unrepresentable rather than discouraged.
