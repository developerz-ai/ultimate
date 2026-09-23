# 02 — Time: months and closure ranges

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 1.

Rule: month math clamps to the last day of the target month, and does it the same way for plain
dates and for zoned instants.

## Files to change
- `packages/time/src/plain-date.ts:124` area — `addPlainMonths(date, months)`.
  - Whole numbers only, checked like `addPlainDays` (`Number.isSafeInteger`, `scheduleInvalid`).
  - `2026-01-31 + 1 → 2026-02-28`, `2024-01-31 + 1 → 2024-02-29`, `2026-03-31 − 1 → 2026-02-28`.
- `packages/time/src/zoned.ts` — `addMonthsInZone(at, months, zone)`: keep the local wall-clock time and apply `addPlainMonths` to the local date. Resolve through `fromZoned` with the existing gap and overlap policies. It never uses UTC month math.
- `packages/time/src/plain-date.ts` — `plainDateRange(from, to)`, returning an inclusive `readonly PlainDate[]`.
  - Refuses `from > to` and ranges over 3,660 days (`scheduleInvalid`).
  - This is how a multi-week recess becomes `holidays: [...fixed, ...plainDateRange('2026-12-20', '2027-01-10')]`. `BusinessCalendar` (`business.ts:19-26`) keeps its one list, and no second `closures` field is added (axiom 1).
- `packages/time/src/business.ts:30-33` — `isHoliday` does `holidays.includes()` per day. Build a `Set` once per calendar through a `WeakMap<BusinessCalendar, Set>` so a 21-day range times N lookups is not quadratic.
- `packages/time/src/index.ts:104-148` — export the three functions.
- `packages/time/README.md` — "Months clamp", plus a "Closures are dates" example (a fixed holiday list plus a range).

## Steps
1. Implement `addPlainMonths` over `plainDateParts`/`plainDateOf` (`plain-date.ts:81-90`).
2. Implement `addMonthsInZone` on top of it.
3. Add `plainDateRange` and the memoised holiday set.

## Tests
- `bun test packages/time/src/plain-date.test.ts packages/time/src/zoned.test.ts packages/time/src/business.test.ts`.
- A table of clamp cases, including leap years and negatives.
- `addMonthsInZone` across a DST boundary in `America/New_York` keeps 09:00 local.
- `America/Bogota` (no DST) keeps 00:00.
- `addBusinessDays` over a calendar holding a 21-day range skips all 21 days.

## Done when
- `addPlainMonths('2026-01-31', 1) === '2026-02-28'`.
- A renewal computed from `2026-01-31` in `America/Bogota` for 12 months never drifts to the 28th after February (each month is computed from the anchor, not chained). The README states this as the recommended pattern.
