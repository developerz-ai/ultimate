# @ultimat3/money — agent notes

**Tier 1.** May import `@ultimat3/core`, `@ultimat3/schema`. No external deps, ever.
`Money = { readonly minor: number; readonly currency: string }` is the shape the whole framework
passes around.

**`Money` is an alias, not a declaration.** It is `@ultimat3/schema`'s `MoneyValue` — tier 0, the
only tier every package may import — and `@ultimat3/entity`'s `MoneyValue` is the same alias. Never
restate the shape here: it was three structural copies, the entity layer's had a `bigint` `minor`,
and a row that layer decoded therefore threw inside `JSON.stringify` and failed `t.money`. That is
also why `minor` is a `number` and stays one — money crosses every wire this framework projects,
and `JSON.stringify` refuses a bigint. `packages/entity/src/type-pins.ts` fails the build if the
alias is re-declared, if `minor` widens back to a `bigint`, or if either field loses `readonly`.

## Boundary

| File | Single responsibility |
|---|---|
| `money.ts` | the value type + constructors (`money`, `fromDecimal`, `toDecimalString`) |
| `currency.ts` | ISO-4217 table + minor-unit exponent. Every scale derives from here. |
| `arithmetic.ts` | add/subtract/multiply/compare, refuses mixed currencies |
| `allocate.ts` | largest-remainder splits that preserve the total |
| `factor.ts` | the exact fraction a scaling factor's decimal spelling names. `factorFraction` is internal — never exported; the `Fraction` **type** is public, because `ExchangeRate.ratio` is one |
| `rounding.ts` | explicit modes, no implicit default, over a float (`roundToInteger`) or a ratio (`roundRatio`) |
| `format.ts` | `Intl.NumberFormat` only, digits from the exponent |
| `convert.ts` | explicit rate + `RateProvider`, records provenance |

## Rules

- Never a float in a stored or returned amount. `fromDecimal` takes a **string**.
- Never `/ 100`. Use `scaleOf(currency)` / `exponentOf(currency)`.
- Never combine currencies without `convert()` first.
- Never round without naming a `RoundingMode` in the call or accepting the stated default.
- **Never scale in floats and round after.** `multiply`, `divide` and `convert` take the factor's
  decimal spelling as an exact fraction (`factorFraction`) and hand it to `roundRatio`, so the mode
  judges 100.5 and not the 100.49999999999999 `100 * 1.005` produces. A new scaling entry point
  goes through the same pair — `roundToInteger(a * b, mode)` is the bug, written again.
- **A derived rate carries its fraction, never its reciprocal.** `fixedRateProvider` answers the
  inverse direction by swapping `ExchangeRate.ratio`'s numerator and denominator: a table naming
  `USD/EUR: 0.92` names 23/25, so EUR→USD is exactly 25/23, where `1 / 0.92` is a double whose own
  decimal spelling rounds a large amount one minor unit low. `rate` stays the readable number the
  audit trail records; `convert` scales by `ratio` whenever the provider supplied one.
- **One place decides a sign.** `formatMoney` is `formatMoneyParts` joined, and `accounting`
  reaches `Intl` as `currencySign` — so the locale places the minus and picks the parenthesised
  form, and a UI styling the parts cannot render a different format from the label beside it.
- Adding a currency: one row in `currency.ts` with its correct exponent, plus a format test.

## Commands

```
bun test packages/money
bun run --filter @ultimat3/money typecheck
```
