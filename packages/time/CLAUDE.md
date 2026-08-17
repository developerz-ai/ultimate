# @ultimat3/time — agent notes

**Tier 1.** May import `@ultimat3/core`, `@ultimat3/schema`. No external deps — **never add
`date-fns-tz`**; zone math is `Intl.DateTimeFormat` + `formatToParts`.

## Boundary

| File | Single responsibility |
|---|---|
| `instant.ts` | the UTC `Instant` brand, ISO/epoch conversion, `now(clock)`, `epoch()` |
| `zones.ts` | IANA validation, `offsetAt` (minutes east), zone labels |
| `zone-canonical.ts` | one zone, one key: `canonicalTimeZone` — the casing/alias collapse every cache keys on |
| `locale-canonical.ts` | one locale, one key: `canonicalLocale` — the same collapse for the `Accept-Language` half |
| `intl-cache.ts` | the one bounded FIFO every `Intl` formatter cache in this package uses |
| `zoned.ts` | `toZoned` / `fromZoned` + gap and overlap policies. Everything depends on this. |
| `format.ts` | `Intl` rendering. Every function takes `locale` **and** `zone`. |
| `duration.ts` | `'2h30m'` ⇄ ms |
| `cron.ts` | barrel over the three cron modules — the only one `index.ts` re-exports |
| `cron-parse.ts` | field grammar → `CronExpression`. Non-integer, non-name tokens are rejected. |
| `cron-occurrence.ts` | next occurrence, wall-clock driven |
| `cron-describe.ts` | `describeCron` — `Intl` names, phrases injected. `CronPhrases` is required. |
| `schedule.ts` | `nextLocalSlot` — "09:00 local tomorrow" |
| `business.ts` | weekends as config, holidays as local dates |
| `context.ts` | request timezone: which source wins, and reading core's `Ctx.tz` back off the ALS |

## Rules

- Never format without an explicit `timeZone`. No ambient default, no `toLocaleString()`.
- **The ambient zone IS `Ctx.tz`**, core's own declared field. This package publishes no writer and
  no field of its own: `createContext({ tz })` and `withChildContext({ tz })` are the way in,
  `currentTimeZone()` the way out. It kept `attachTimeZone`/`timeZoneOf` over `ctx['timeZone']`
  until 1.3.0 — a second ambient store, with **zero** writers, while `@ultimat3/http` wrote `tz` —
  so `currentTimeZone()` answered `UTC` for every request and every `@ultimat3/ui` server render
  formatted in UTC regardless of the zone the caller sent. Two ambient defaults is the worst
  possible version of the rule above. Never reintroduce either half.
- **Never cache an `Intl` formatter on a raw caller string.** A zone and a locale both arrive from
  a request header, so the key must be canonical (`canonicalTimeZone` for a zone, `canonicalLocale`
  for a locale) and the cache must be bounded (`cachedFormatter`, `intl-cache.ts`). An unbounded
  `Map` keyed on `x-timezone` grew 31 MB for 4,096 casings of one zone name, and the casing space
  of a 13-letter zone is 2^12. **Both halves, always** — a canonical key does not bound anything
  (an unknown `-u-` extension value survives canonicalization as a distinct string) and the cap
  alone lets one locale evict itself under three spellings.
- **Never hand back the caller's own `Date`, and never export a shared one.** `Instant` is a
  branded `Date` and a `Date` cannot be frozen — `Object.freeze` does not close `setTime`, the
  value is in an internal slot. So `instant()` copies and `epoch()` is a function, not a constant.
- **`businessDaysBetween` is `[from, to)` on local calendar dates** — the interval `daysBetween`
  measures, so the two can never disagree. Comparing instants made the answer depend on the
  endpoints' time of day. A new day-counting function states its interval in its header.
- **`describeCron` declines what it cannot say.** `CronPhrases` is the caller's vocabulary and has
  no seconds phrase, so a 6-field expression with a non-trivial seconds field is
  `X_CRON_NOT_DESCRIBABLE`. Adding a required field to `CronPhrases` would break every caller
  (`packages/cli/src/cmd-tasks.ts` builds one) to describe a schedule almost nobody writes.
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
