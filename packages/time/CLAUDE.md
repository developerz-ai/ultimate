# @ultimat3/time — agent notes

**Tier 1.** May import `@ultimat3/core`, `@ultimat3/schema`. No external deps — **never add
`date-fns-tz`**; zone math is `Intl.DateTimeFormat` + `formatToParts`.

## Boundary

| File | Single responsibility |
|---|---|
| `instant.ts` | the UTC `Instant` brand, ISO/epoch conversion, `now(clock)`, `epoch()` |
| `zones.ts` | IANA validation, `offsetAt` (minutes east), zone labels |
| `zone-canonical.ts` | one zone, one key: `canonicalTimeZone` — the casing/alias collapse every cache keys on |
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
| `plain-date.ts` | `PlainDate` — a calendar date with no time and no zone, and the two conversions to an instant |

## Rules

- Never format without an explicit `timeZone`. No ambient default, no `toLocaleString()`.
- **The ambient zone IS `Ctx.tz`**, core's own declared field. This package publishes no writer and
  no field of its own: `createContext({ tz })` and `withChildContext({ tz })` are the way in,
  `currentTimeZone()` the way out. It kept `attachTimeZone`/`timeZoneOf` over `ctx['timeZone']`
  until 1.3.0 — a second ambient store, with **zero** writers, while `@ultimat3/http` wrote `tz` —
  so `currentTimeZone()` answered `UTC` for every request and every `@ultimat3/ui` server render
  formatted in UTC regardless of the zone the caller sent. Two ambient defaults is the worst
  possible version of the rule above. Never reintroduce either half.
- **`Intl` answers "can I format this", never "is this an IANA zone", and the two stopped
  agreeing.** ICU 78 (Bun 1.4) RESOLVES `CET`, `EST`, `EST5EDT`, `GMT`, `MST` and their families
  where ICU 75 threw, so a runtime upgrade alone reopened the golden rule above — silently, and in
  the direction that fails dangerous: an abbreviation names no DST rule. So the judgement is never
  delegated to `Intl`. `canonicalTimeZone` asserts the structural property itself: a zone is
  `Area/Location`, and `UTC` is the one legal exception. Never a denylist of the names ICU newly
  accepts — that list grows with every tzdata and ICU release, and no rule in it keeps `CET` out
  while letting `Japan` in, both being one label. The single-label `backward` links go with them
  (`Japan` → `Asia/Tokyo`, `GB` → `Europe/London`) and that is the point: the slashed spelling is
  the one that survives being a formatter-cache key. **Breaking at 6.0.0.** `zones.test.ts` pins
  one named case per refused name, so an ICU bump that reopens one names it.
- **Never cache an `Intl` formatter on a raw caller string.** A zone and a locale both arrive from
  a request header, so the key must be canonical (`canonicalTimeZone` for a zone, `canonicalLocale`
  for a locale) and the cache must be bounded (`cachedFormatter`). **`cachedFormatter`,
  `MAX_CACHED_FORMATTERS` and `canonicalLocale` are `@ultimat3/core`'s as of 2.0.0**, not this
  package's: `@ultimat3/money` hit the identical unbounded-`Map`-on-a-header bug and tier 1 may not
  import sideways, so the mechanism moved down a tier rather than being copied. An unbounded
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
- **A `PlainDate` is a branded STRING, and the golden rule does not apply to it** — decided
  2026-08 for `@ultimat3/entity`'s `date()` column. "Never format a date without a zone" is about
  INSTANTS; a calendar date names no instant, so it needs no zone, and giving it one is the bug:
  `effective_on` stored as a `timestamptz` is a different date on either side of midnight for half
  the planet. Not a `Date` (that is an instant, and binding one to a Postgres `date` parameter
  fails outright — `time zone "gmt-0500" not recognized`, measured on 17.10) and not
  `{ year, month, day }` (an object sorts by nothing and JSON-stringifies as three fields). The ISO
  string sorts lexicographically exactly as it sorts chronologically, which is why every cursor,
  `orderBy` and `compare` in the framework handles it with no special case at all.
- **`plainDateIn` takes a zone and `plainDateUtc` does not, and neither is a default for the
  other.** An instant has a calendar date only in a zone; a `Date` a driver returns for a `date`
  column is midnight UTC and reading its LOCAL fields loses a day west of Greenwich. `bun test`
  pins the process to UTC, so that bug is invisible to every in-process test — `plain-date.test.ts`
  spawns a subprocess with `TZ=America/Los_Angeles` for exactly one assertion, and that is the only
  reason it can fail.
- **`fromIso` refuses a clock time with no offset.** `new Date('2026-03-14T09:00')` is the
  PROCESS's 09:00, so one CSV row imported on two pods becomes two instants — the ambient default
  this package exists to abolish, inside its own entry point. `Z` or an offset, or `X_INSTANT_INVALID`;
  wall-clock input is `fromZoned(wall, zone)`, which names its zone. A date-only form carries no
  clock time and is UTC by specification, so it still parses.
- **`fromEpochMs` checks the `Date` RANGE, not `Number.isFinite`.** ±8.64e15 ms is the limit, so a
  finite `1e16` used to hand back an Invalid Date branded as an `Instant` — a value `isInstant`
  answers `false` for (the type's own predicate rejecting what its constructor certified) and
  `toIso` throws a bare `RangeError` out of. `fromEpochSeconds`, `addMs`, `subtractMs` and
  `now(clock)` all reach it and none re-checks, so the one test is `new Date(ms).getTime()` being
  NaN — exactly what `instant()` already does.
- **`configureTime({ defaultZone })` goes through `assertTimeZone`**, which validates AND
  canonicalizes. It did neither: `'Mars/Olympus'` was accepted at boot and first refused inside a
  formatter at render time, from a stack naming no configuration, and `'eUrOpE/bErLiN'` travelled
  the process as its own zone string minting a permanent entry in every formatter cache. It throws
  where `resolveTimeZone` skips — a stale header must not fail a request, a default nothing can
  fall back to is a boot-time mistake with no second answer.
- **`formatIsoDate` is built from `isoDateInZone`, never from `Intl` directly.** `year: 'numeric'`
  neither zero-pads a year below 1000 nor carries the era, so it answered `'50-01-01'` where
  `isoDateInZone` answered `'0050-01-01'` — two functions in one package answering one question
  differently, and the short form matches no ISO pattern and is rejected by the `<input type="date">`
  it exists for. One padding rule, in one place.
- **`ordinal(value)` takes no locale.** It used to accept one, select the plural CATEGORY with it,
  and append the ENGLISH suffix for that category regardless: `ordinal(1, 'de')` was `'1th'`. A
  parameter that cannot change the answer correctly is removed, so a caller wanting a localized
  ordinal hears it from `tsc`. **Breaking.**
- **A day count is a whole number, and `formatDuration`'s `maxUnits` is at least 1.**
  `addBusinessDays(at, 0.5)` moved a whole day and `NaN` returned the input unchanged, which reads
  as "no movement was needed"; `maxUnits: 0` made the ceiling test true before the first unit, so
  every duration rendered as "0 sec". Both refuse through `scheduleInvalid`, the in-package generic
  range refusal `addPlainDays` already uses — not clamped, for the reason that error's own fix line
  gives.
- **`toSeconds` carries the sign out and rounds the MAGNITUDE.** `Math.round` breaks ties toward
  `+Infinity`, so `'1500ms'` was 2 and `'-1500ms'` was -1. `@ultimat3/money`'s `rounding.ts` is the
  framework's statement of this, and its `signed()` is why zero never comes back as `-0`.
- **`parseDuration` rejects an ISO body by its GROUPS, never by its total.** `'PT0S'` — the
  canonical zero most emitters write — was refused along with `'PT0H0M0S'` and `'P0W'`, while
  `'P0D'` was let through by a special case. `ISO_8601` already requires a component group for any
  body past a bare `'P'`, which is the case the guard was written for.
- **An impossible day/month pair is refused by `parseCron`, in constant time.**
  `isValidCron('0 0 30 2 *')` answered `true` and the refusal arrived ~150 ms later out of
  `nextCronOccurrence`, after 200,000 walk steps — a cost `firedSince` pays on every tick of the
  scheduler's leader loop. February is 29 in the table because leap years happen, and the check
  applies ONLY when day-of-month is restricted and day-of-week is not: Vixie's OR means
  `0 0 30 2 5` fires every Friday in February, so refusing it would break a working schedule.
  `MAX_STEPS` stays as the backstop for what the check cannot see.
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
