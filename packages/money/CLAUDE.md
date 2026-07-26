# @ultimat3/money — agent notes

**Tier 1.** May import `@ultimat3/core`, `@ultimat3/schema`. No external deps, ever.
`Money = { minor: number; currency: string }` is the shape the whole framework passes around.

## Boundary

| File | Single responsibility |
|---|---|
| `money.ts` | the value type + constructors (`money`, `fromDecimal`, `toDecimalString`) |
| `currency.ts` | ISO-4217 table + minor-unit exponent. Every scale derives from here. |
| `arithmetic.ts` | add/subtract/multiply/compare, refuses mixed currencies |
| `allocate.ts` | largest-remainder splits that preserve the total |
| `rounding.ts` | explicit modes, no implicit default |
| `format.ts` | `Intl.NumberFormat` only, digits from the exponent |
| `convert.ts` | explicit rate + `RateProvider`, records provenance |

## Rules

- Never a float in a stored or returned amount. `fromDecimal` takes a **string**.
- Never `/ 100`. Use `scaleOf(currency)` / `exponentOf(currency)`.
- Never combine currencies without `convert()` first.
- Never round without naming a `RoundingMode` in the call or accepting the stated default.
- Adding a currency: one row in `currency.ts` with its correct exponent, plus a format test.

## Commands

```
bun test packages/money
bun run --filter @ultimat3/money typecheck
```
