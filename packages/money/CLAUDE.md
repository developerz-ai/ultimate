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

**The widening a WRITE accepts is `@ultimat3/entity`'s `MoneyInput`, and `RowWrite<Row>` is how a
caller spells it**, `As of 2026-08-25`. A minor unit read straight off a `bigint` column reaches
`Repo.insert`/`insertAll`/`upsertAll` with no conversion at the call site and is narrowed there,
before an invariant or a statement sees it — so nothing in THIS package ever meets a `bigint`
`minor`, and nothing here should learn to. `type-pins.ts` pins both halves: those three writes take
the wide shape and answer with the row type.

## Boundary

| File | Single responsibility |
|---|---|
| `money.ts` | the value type + constructors (`money`, `fromDecimal`, `toDecimalString`) |
| `currency.ts` | the currency table — the ISO-4217 rows shipped, the rows an app registers, and the minor-unit exponent every natural scale derives from |
| `scale.ts` | what decimal place a value's `minor` counts (`moneyScale`), which scales are legal (`assertScale`), and the exact bigint widening every comparison starts with (`minorAt`) |
| `rescale.ts` | moving between scales: widening exact, lossy narrowing only with a named mode |
| `arithmetic.ts` | add/subtract/multiply/compare, refuses mixed currencies |
| `allocate.ts` | largest-remainder splits that preserve the total |
| `factor.ts` | the exact fraction a scaling factor's decimal spelling names. `factorFraction` is internal — never exported; the `Fraction` **type** is public, because `ExchangeRate.ratio` is one |
| `rounding.ts` | explicit modes, no implicit default, over a float (`roundToInteger`) or a ratio (`roundRatio`, and `roundToDigits` through it) |
| `format.ts` | `Intl.NumberFormat` only, digits from the exponent |
| `convert.ts` | explicit rate + `RateProvider`, records provenance |

## Rules

- Never a float in a stored or returned amount. `fromDecimal` takes a **string**.
- Never `/ 100`, and never `exponentOf(amount.currency)` for a value's own precision — that is
  `moneyScale(amount)`, which falls back to the currency and is right for both. `exponentOf` and
  `scaleOf` still answer for a *currency*, which is a different question.
- **A stated currency is an ASSERTION, never a fallback.** `sum(amounts, currency)` used its
  second argument only when the list was empty and ignored it entirely once a first addend existed:
  `sum([money(1, 'EUR')], 'USD')` answered `{ minor: 1, currency: 'EUR' }`, so a caller who wrote
  down USD received EUR with nothing refused — in the one entry point of a file whose header is
  "Integer arithmetic that refuses to mix currencies". A stated currency the first addend
  contradicts is `X_CURRENCY_MISMATCH`.
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
- **Never scale in floats and round after.** `multiply`, `divide`, `convert` **and `fromDecimal`**
  take the decimal spelling as an exact fraction (`factorFraction`, or the digit strings
  themselves) and hand it to `roundRatio`, so the mode judges 100.5 and not the
  100.49999999999999 `100 * 1.005` produces. A new scaling entry point goes through the same pair
  — `roundToInteger(a * b, mode)` is the bug, written again. `fromDecimal` was the last float
  path and it is the one every user-typed price goes through: `Number('0.4999999999999999999')`
  is exactly 0.5, so `half-up` saw a tie the written decimal does not have. **`roundToDigits` was
  that rule broken in this very file** — its body was literally `roundToInteger(value * factor,
  mode) / factor`, so `roundToDigits(1.005, 2, 'half-up')` answered 1.00 where 1.01 is owed. It
  goes through `factorFraction` + `roundRatio` as of 2026-08, and a digit count that is not a whole
  number of decimal places is `X_MONEY_SCALE_INVALID`, never a bare `RangeError` out of `BigInt`.
- **`convert` preserves the amount's own `scale`.** `exponentOf(target)` decides the natural scale
  of a value that names none; a value that names one keeps it, because narrowing $0.000002 to
  EUR's two decimals is the 10,000x reinterpretation `scale` was added to prevent. Same rule as
  `multiply` and `divide`, which already kept theirs.
- **`money()` normalises `-0` to `0`.** One amount must not have two identities: `JSON.stringify`
  writes `-0` as `0` while `Object.is` and any keyed `Map` see something else, so a refund
  rounding to nothing produced a value its own wire format cannot reproduce. `roundToInteger`
  refuses to produce it either — `sign * 0` is the source.
- **An audit timestamp is never fabricated.** `convertWith`'s identity branch takes `{ at }` or an
  injected `{ clock }` (default `systemClock`); `new Date(0)` claimed a parity observed in 1970.
- **A derived rate carries its fraction, never its reciprocal.** `fixedRateProvider` answers the
  inverse direction by swapping `ExchangeRate.ratio`'s numerator and denominator: a table naming
  `USD/EUR: 0.92` names 23/25, so EUR→USD is exactly 25/23, where `1 / 0.92` is a double whose own
  decimal spelling rounds a large amount one minor unit low. `rate` stays the readable number the
  audit trail records; `convert` scales by `ratio` whenever the provider supplied one.
- **Never cache an `Intl` formatter on a raw caller string.** `locale` arrives from
  `Accept-Language`, so an unbounded `Map` keyed on it is memory the client chooses: 20,000 valid
  `en-US-x-*` tags through `formatMoney` retained +55.1 MB of RSS, at ~2.7 KB per
  `Intl.NumberFormat`. Both halves, always — `assertLocale` for the key, `cachedFormatter` for
  the bound, both `@ultimat3/core`'s and shared with `@ultimat3/time` (tier 1 may not import
  sideways, so the mechanism lives a tier down rather than twice). Every formatter in `format.ts`
  goes through that pair; a `new Intl.NumberFormat` outside one is the bug written again.
- **A malformed locale tag is `X_LOCALE_INVALID`, never a bare `RangeError`, `As of 2026-08-26`.**
  `formatMoney`, `formatMoneyParts`, `formatMoneyDecimal` and `currencySymbol` all screen through
  `assertLocale` (`@ultimat3/core`), which validates and canonicalizes in ONE step — so the key the
  cache is bounded on is the tag the screen accepted. The pass-through it replaced was argued as
  "this seam decides a cache key, never whether a locale is acceptable", which is true of the cache
  and was never an argument for handing the tag to `Intl.NumberFormat`: `en_US` off an
  `Accept-Language` header took the request down with an uncoded throw several frames away.
  `@ultimat3/time` had closed the identical hole one release earlier, and money was the last
  tier-1 package still doing what time deleted.
- **One place decides a sign.** `formatMoney` is `formatMoneyParts` joined, and `accounting`
  reaches `Intl` as `currencySign` — so the locale places the minus and picks the parenthesised
  form, and a UI styling the parts cannot render a different format from the label beside it.
- **The table is open, and it is opened by a call.** `registerCurrency({ code, exponent, name })` is
  how an app adds a currency the shipped rows do not carry — axiom 8: `As of 2026-08`, 53 of ~180
  ISO codes is a *convention*, and a convention an app cannot extend is a fork waiting to happen.
  The rest of the framework already treated the set as open — `@ultimat3/schema`'s `moneySchema`,
  the published OpenAPI `pattern` and `@ultimat3/entity`'s `char(3)` CHECK all accept any
  `^[A-Z]{3}$` — so an unregistered code could arrive over HTTP and reach a row, and only
  arithmetic refused it.
- **What a well-formed code IS lives in `packages/schema/src/money-value.ts`, and nothing here
  restates it.** `CURRENCY_CODE_PATTERN` is the pattern *source* — a string, because the two
  projections that cannot call a predicate need it: the published OpenAPI `pattern` and
  `@ultimat3/entity`'s Postgres `~` CHECK — and `isCurrencyCode` is the predicate over it,
  `isMoneyScale`'s twin, taking `unknown` because every caller is a boundary. `registerCurrency`
  imports it for exactly the reason `assertScale` imports `isMoneyScale`, and `currency.test.ts`
  asserts the shipped table through it rather than through a local regex. Never write
  `/^[A-Z]{3}$/` in this package: it was seven copies across the repo, each individually correct,
  and the only place a divergence would have surfaced is a psql session or a generated client.
- **A registration is refused, never defaulted.** No exponent is guessable: a silent 2 reads
  `1.23456789 XBT` as `1.23` and a stored `minor` shifts by a power of ten. Bad shape, bad exponent
  or an empty name is `X_CURRENCY_INVALID`; a second declaration of one code is
  `X_CURRENCY_REDEFINED`, and an **identical** one is a no-op so a twice-imported module is not a
  crash. A shipped ISO row cannot be redefined at all.
- **A shipped row is frozen, and `CurrencyInfo`'s three fields are `readonly`.** `currencyInfo()`
  hands the row itself out by reference, and `exponent` decides what every stored `minor` in that
  currency counts — one `currencyInfo('USD').exponent = 3` silently rescales every USD amount in
  the process by a power of ten, through the one door `registerCurrency` already refuses
  (`X_CURRENCY_REDEFINED`). The compiler is the first guard, `Object.freeze` on the array AND on
  every row the second, for the caller that has no types. Both halves: a frozen array of writable
  rows guards the list and leaves every value in it open.
- **A `fix:` naming `fromDecimal` must name a call that RUNS.** `moneyNotInteger` emitted
  `fromDecimal('<minor>', '<ccy>')` for every arrival: it threw this same code straight back for
  anything past the currency's own digits, read `fromDecimal('1e+21', …)` for a magnitude
  `DECIMAL` refuses, and read `fromDecimal('0', …)` for `NaN`, which runs and invents an amount.
  Three arrivals, three instructions — a rounding call for a fractional minor, `{ scale: d }` or
  `{ rounding: 'half-up' }` when the value is really a major-unit amount, and NO call at all where
  none could work. `errors.test.ts` executes every call a `X_MONEY_NOT_INTEGER` fix line names.
- **Two enumerations, two questions.** `CURRENCIES` is the constant this package ships;
  `currencyCodes()` is what this process accepts, registrations included, and it is the list
  `X_CURRENCY_UNKNOWN`'s fix line names — so it must include them or that fix is the dead end it
  used to be.
- Adding a currency to the *shipped* rows: one row in `currency.ts` with its correct exponent, plus
  a format test. An app never needs this — that is what `registerCurrency` is for.

## Commands

```
bun test packages/money
bun run --filter @ultimat3/money typecheck
```
