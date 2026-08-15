# @ultimat3/money — agent notes

**Tier 1.** May import `@ultimat3/core`, `@ultimat3/schema`. No external deps, ever.
`Money` is the shape the whole framework passes around, and the shape itself is declared once, in
`packages/schema/src/money-value.ts` — read it there rather than trusting a copy here, which is
the same reason `type-pins.ts` pins invariants instead of a snapshot. What this package adds is
the *meaning* of the optional `scale`: the decimal exponent `minor` counts in when it is not the
currency's own. Absent on every value that predates it, and absent again whenever it would only
restate the currency, so an amount at the natural scale has exactly one encoding and existing
JSON is untouched.

**`Money` is an alias, not a declaration.** It is `@ultimat3/schema`'s `MoneyValue` — tier 0, the
only tier every package may import — and `@ultimat3/entity`'s `MoneyValue` is the same alias. Never
restate the shape here: it was three structural copies, the entity layer's had a `bigint` `minor`,
and a row that layer decoded therefore threw inside `JSON.stringify` and failed `t.money`. That is
also why `minor` is a `number` and stays one — money crosses every wire this framework projects,
and `JSON.stringify` refuses a bigint. `packages/entity/src/type-pins.ts` fails the build if the
alias is re-declared, if `minor` widens back to a `bigint`, if any field loses `readonly`, if a
fourth field appears — or if `scale` ever stops being optional, which is the pin that says the
shape is still additive and this is still a minor version.

## Boundary

| File | Single responsibility |
|---|---|
| `money.ts` | the value type + constructors (`money`, `fromDecimal`, `toDecimalString`) |
| `currency.ts` | ISO-4217 table + minor-unit exponent. Every natural scale derives from here. |
| `scale.ts` | what decimal place a value's `minor` counts (`moneyScale`), which scales are legal (`assertScale`), and the exact bigint widening every comparison starts with (`minorAt`) |
| `rescale.ts` | moving between scales: widening exact, lossy narrowing only with a named mode |
| `arithmetic.ts` | add/subtract/multiply/compare, refuses mixed currencies |
| `allocate.ts` | largest-remainder splits that preserve the total |
| `factor.ts` | the exact fraction a scaling factor's decimal spelling names. `factorFraction` is internal — never exported; the `Fraction` **type** is public, because `ExchangeRate.ratio` is one |
| `rounding.ts` | explicit modes, no implicit default, over a float (`roundToInteger`) or a ratio (`roundRatio`) |
| `format.ts` | `Intl.NumberFormat` only, digits from the exponent |
| `convert.ts` | explicit rate + `RateProvider`, records provenance |

## Rules

- Never a float in a stored or returned amount. `fromDecimal` takes a **string**.
- Never `/ 100`, and never `exponentOf(amount.currency)` for a value's own precision — that is
  `moneyScale(amount)`, which falls back to the currency and is right for both. `exponentOf` and
  `scaleOf` still answer for a *currency*, which is a different question.
- **Two scales meet at the finer one, never the coarser.** `add`, `subtract` and `compare`
  widen through `minorAt` (bigint, exact) before they do anything else, so a sub-cent fee added to
  a cent survives and a comparison answers where storing the widened value would rightly be
  refused. Rounding down to the coarser scale would silently delete the smaller operand.
- **Lossy narrowing names its mode at the call.** `rescale(m, 2)` throws rather than drop a
  non-zero digit; `rescale(m, 2, 'half-up')` is the same rule `fromDecimal` applies to excess
  precision. A narrowing that loses nothing needs no mode — nothing is being decided.
- **`money()` is the only place the canonical form is decided.** It drops a `scale` equal to the
  currency's exponent — only equal, so a deliberately *coarser* scale (`money(5, 'USD', 0)`, whole
  dollars) is kept exactly as a finer one is. Every constructor, every arithmetic result and every
  allocation part therefore agree on one encoding without any of them repeating the rule.
- **A widened value that will not fit is a scale error, not a fractional-minor one.** `add`,
  `subtract` and `rescale` convert through `toMinor`, which throws `X_MONEY_SCALE_INVALID` naming
  the finest scale that fits. Letting `money()` refuse the raw number reported a fractional minor
  nobody wrote, with a `fromDecimal` fix line that threw the same error again.
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
