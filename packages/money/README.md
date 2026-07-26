# 💶 @ultimat3/money

**Golden rule: integer minor units, currency always attached, `Intl` at the edge.**
`0.1 + 0.2 !== 0.3`, so no amount is ever a float. `Money` is `{ minor, currency }` — the
two travel together, and arithmetic across two currencies throws instead of guessing.

| Concern | Store | Format |
|---|---|---|
| Amount | integer minor units (`1299`) | `Intl.NumberFormat`, `style: 'currency'` |
| Currency | ISO-4217 code (`'EUR'`) | fraction digits derived from its exponent |
| Scale | never | `10 ** exponentOf(currency)` — never a literal `/ 100` |
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

## Errors

| Code | When |
|---|---|
| `X_MONEY_NOT_INTEGER` | fractional minor units, or a decimal string more precise than the currency |
| `X_CURRENCY_UNKNOWN` | code not in the ISO-4217 table |
| `X_CURRENCY_MISMATCH` | arithmetic across two currencies |
| `X_ALLOCATION_INVALID` | bad part count, empty/negative/all-zero ratios, percentages ≠ 100 |
| `X_RATE_MISSING` | no rate for the pair — never assumes parity |

## Why it exists

Every money bug in production is one of three things: a float, a missing currency, or a
lost cent in a split. This package makes all three unrepresentable rather than discouraged.
