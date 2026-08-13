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
