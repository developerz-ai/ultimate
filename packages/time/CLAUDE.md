# @ultimat3/time — agent notes

**Tier 1.** May import `@ultimat3/core`, `@ultimat3/schema`. No external deps — **never add
`date-fns-tz`**; zone math is `Intl.DateTimeFormat` + `formatToParts`.

## Boundary

| File | Single responsibility |
|---|---|
| `instant.ts` | the UTC `Instant` brand, ISO/epoch conversion, `now(clock)` |
| `zones.ts` | IANA validation, `offsetAt` (minutes east), zone labels |
| `zoned.ts` | `toZoned` / `fromZoned` + gap and overlap policies. Everything depends on this. |
| `format.ts` | `Intl` rendering. Every function takes `locale` **and** `zone`. |
| `duration.ts` | `'2h30m'` ⇄ ms |
| `cron.ts` | parse + next occurrence, wall-clock driven |
| `schedule.ts` | `nextLocalSlot` — "09:00 local tomorrow" |
| `business.ts` | weekends as config, holidays as local dates |
| `context.ts` | request timezone via ALS |

## Rules

- Never format without an explicit `timeZone`. No ambient default, no `toLocaleString()`.
- Never add `86_400_000` to cross a day boundary — use `addDaysInZone` / `fromZoned`.
- Never take the clock from `Date.now()`; accept a `Clock` (`now(clock)`).
- Cron and schedules iterate the **local wall clock**, then convert once with `fromZoned`.
- `m` is minutes, `ms` is milliseconds. A bare number is not a duration.
- Tests must cover a spring-forward gap, a fall-back overlap and a non-hour offset zone.

## Commands

```
bun test packages/time
bun run --filter @ultimat3/time typecheck
```
