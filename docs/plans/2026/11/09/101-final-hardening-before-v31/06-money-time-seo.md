# 06 — money, time, seo: coded refusals and linear-time calendars

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 1 (`money`, `time`, `seo`).

## Findings
| # | Sev | Site | Failure | Fix |
|---|---|---|---|---|
| M1 | Med | `money/src/money.ts:71` | `fromDecimal(12.99 as unknown as string, 'USD')`, `undefined`, `null` → bare `TypeError`, no code. A JSON body carrying a number is a 500 | `typeof value !== 'string'` → coded refusal, as `storage/src/path.ts:47` |
| M2 | Med | `money/src/errors.ts:245-250` (`decimalNotNumeric`) | raw input in `cause:` unbounded (100k-char input → 100,073-char cause); code `X_MONEY_NOT_INTEGER` for a parse failure | render through `renderCauseValue` (`core/src/error-render.ts:56`); new code `X_MONEY_NOT_DECIMAL` via `bun run new-error-code` — the old code stays registered for the integer case |
| M3 | Low | `seo/src/sitemap-datetime.ts:9-31` | private regex + `Date.parse` rolls impossible dates: `2026-02-30` → `2026-03-02`. The feed path (`feed-dates.ts:18`) uses schema's `isIsoDateTime` and refuses | use `isIsoDateTime` from `@ultimat3/schema` (tier 0, legal); delete the regex |
| M4 | Low–Med (perf) | `time/src/business.ts` (`businessDaysBetween`, `addBusinessDays`) | one local day per step, 2–3 Intl calls per day: 30 years 832 ms; `addBusinessDays(…, 5000)` 501 ms | whole weeks arithmetically, walk only the remainder, subtract in-range holidays from `holidaySet` |
| M5 | Low (perf) | `time/src/format.ts` (`formatRelative`) | new `Intl.RelativeTimeFormat` per call: 10k calls 361 ms | route through `cachedFormatter`, like `formatterFor` |

## Files to change
- `packages/money/src/money.ts`, `errors.ts`; `wiki/Error-Codes.md` row (by the generator).
- `packages/seo/src/sitemap-datetime.ts`.
- `packages/time/src/business.ts`, `format.ts`.

## Tests
- `money.test.ts`: number/`undefined`/`null` → `X_MONEY_NOT_DECIMAL`; 100k-char input → bounded cause.
- `sitemap-datetime.test.ts`: `2026-02-30`, `2026-04-31` refused.
- `business.test.ts`: property test against the old loop (kept in the test as the oracle) over random ranges, zones and holiday sets; 30 years < 5 ms.
- `format.test.ts`: 10k `formatRelative` < 30 ms.
- `bun test packages/money packages/time packages/seo`

## Done when
- All five probes above answer as the fix column says.
