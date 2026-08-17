# 🕒 @ultimat3/time

**Golden rule: store UTC, format at the edge, always with an explicit IANA zone.**
An `Instant` is a point on the UTC timeline with no zone attached. Zones exist only where
a human reads the value. No formatter in this package has an ambient default zone, and
none ever will — "the server's timezone" is not an answer to "what time is it for the user".

| Concern | Store | Format / compute |
|---|---|---|
| Instants | UTC (`timestamptz`, ISO-8601 `Z`) | `Intl.DateTimeFormat` + explicit `timeZone` |
| Wall clock | never | `toZoned` / `fromZoned` with a DST policy |
| Zone | on the user record | resolved once per request into the ALS context |
| Durations | milliseconds | `parseDuration('2h30m')`, `formatDuration(ms, locale)` |
| Schedules | cron + IANA zone | `nextCronOccurrence`, `nextLocalSlot` |

No `date-fns-tz`, no tzdata table. Zone math is derived from `Intl.DateTimeFormat` +
`formatToParts`, which is exact in Bun and always current with the runtime's tzdata.

**One zone is one key.** `Intl` accepts every casing of an IANA name, so `canonicalTimeZone(z)`
answers the canonical spelling (or `undefined`), and `assertTimeZone` / `resolveTimeZone` both
return it. Anything reading a zone off a request header should canonicalize before caching on it:
4,096 casings of `Europe/Berlin` used to mint 4,096 permanent `Intl.DateTimeFormat`s, 31 MB.

One **locale** is one key for the same reason — `Accept-Language` spells one locale `EN-us`,
`en-US` and `en-latn-us`, and `formatDateTime` and `describeCron` collapse the three before they
reach a formatter cache. The cap in `intl-cache.ts` stays either way: an unknown `-u-` extension
value survives canonicalization as a distinct string, so the key bounds nothing on its own.

Every value this package hands back is its own object: `instant(date)` copies rather than branding
the caller's `Date`, and `epoch()` is a function — the `EPOCH` constant it replaces was one shared
mutable `Date` that a single `setUTCFullYear` corrupted for the whole process.

## Use

```ts
import { formatWithOffset, fromIso, nextLocalSlot, now, toZoned } from '@ultimat3/time';

const at = fromIso('2026-03-14T08:00:00Z');
formatWithOffset(at, { locale: 'en-GB', zone: 'Europe/Berlin' });
// "14 Mar 2026, 09:00 (GMT+1)"
formatWithOffset(at, { locale: 'en-GB', zone: 'America/New_York' });
// "14 Mar 2026, 04:00 (GMT-4)"

nextLocalSlot({ zone: 'Asia/Kathmandu', hour: 9 }, now(clock)); // 09:00 local, +05:45 handled
```

## DST is a policy, not a guess

`fromZoned(wall, zone, { gap, overlap })` is the function everything else is built on.

| Case | What happens | Policy |
|---|---|---|
| Normal | one instant matches the wall clock | — |
| **Gap** (spring forward) | `02:30` never happens | `'next'` (default), `'previous'`, `'throw'` |
| **Overlap** (fall back) | `01:30` happens twice | `'first'` (default), `'second'`, `'throw'` |

It works by search-and-verify: read the wall-clock fields as if they were UTC, subtract
each candidate offset in force around that moment, then convert each candidate *back* and
keep the ones that reproduce the requested wall clock. Two survivors means overlap, none
means gap. `fromZonedDetailed()` returns which case it was — log it when scheduling.

Half-hour and 45-minute zones (`Asia/Kolkata`, `Asia/Kathmandu`, `Australia/Adelaide`,
`Pacific/Chatham`) are ordinary cases here, not special ones.

## Calendar days

**Never cross a day boundary with `86_400_000`.** A local day is 23, 24 or 25 hours long. Every
one of these takes the zone explicitly, and none of them has a default.

| Function | Answers |
|---|---|
| `startOfDay(at, zone)` / `endOfDay(at, zone)` | local midnight; the last millisecond of the day |
| `addDaysInZone(at, days, zone)` | the same wall-clock time, `days` calendar days away |
| `daysBetween(from, to, zone)` | local day boundaries crossed — signed, always integral |
| `isoDateInZone(at, zone)` | `2026-03-14` |
| `isSameLocalDay(left, right, zone)` | whether two instants share a local date |

`daysBetween` counts boundaries, not milliseconds: 23 real hours across spring forward is `1`,
and 24 real hours inside a 25-hour fall-back day is `0`.

## Cron

`parseCron` handles 5 or 6 fields, `*/n`, ranges, lists, named months and days, `@daily`
macros, and Vixie's dom/dow OR rule. `nextCronOccurrence(expr, zone, after)` iterates the
zone's **wall clock**, so `0 3 * * *` in `Europe/Berlin` stays at 03:00 local across a DST
change, and a job scheduled inside the gap runs at the first existing local time instead of
being skipped. `describeCron(expr, locale, phrases)` renders the dashboard summary — month and
weekday names from `Intl`, every connective word **required** from the caller's `t('time.cron.*')`,
because tier 1 cannot reach `t()` and a built-in default would ship English to every locale. A
long clock-time list is capped and the remainder counted with `andMore`, never silently cut. A
6-field expression whose seconds field says something a 5-field one cannot is **declined** with
`X_CRON_NOT_DESCRIBABLE` rather than summarised: `CronPhrases` has no seconds vocabulary, so a
ten-second step used to render as "every minute".

## Business days

The weekend is configuration. `WEEKEND_SAT_SUN`, `WEEKEND_FRI_SAT` (much of the Gulf),
`WEEKEND_SUN_ONLY`, plus a holiday list of local `YYYY-MM-DD` dates.

`businessDaysBetween(from, to, calendar)` counts `[from, to)` — half-open, on **local calendar
days**, the same interval `daysBetween` measures. `from`'s own day counts, `to`'s does not, and
neither endpoint's wall-clock time is part of the question. A reversed range is the same count
negated; an empty one is `0` in either direction, never `-0`.

## Errors

| Code | When |
|---|---|
| `X_TIMEZONE_INVALID` | not an IANA name (abbreviations and numeric offsets are rejected) |
| `X_CRON_INVALID` | unparseable expression, or one that can never match |
| `X_DURATION_INVALID` | `'3'` with no unit, trailing junk, unknown unit |
| `X_DST_AMBIGUOUS` | overlap hit with `overlap: 'throw'` |
| `X_DST_NONEXISTENT` | gap hit with `gap: 'throw'` |
| `X_INSTANT_INVALID` | unparseable timestamp |
| `X_LOCALE_INVALID` | a tag `Intl` cannot parse (`en_US`, `''`) reached `describeCron` |
| `X_CRON_NOT_DESCRIBABLE` | a valid 6-field cron whose seconds field `CronPhrases` has no words for |
| `X_SCHEDULE_INVALID` | a wall-clock field out of range: `slot.hour`, `slot.minute`, `slot.second`, `slot.weekday` |

## Why it exists

Naive time math breaks quietly: the digest goes out an hour early for half the year, the
reminder never fires on the spring-forward day, and nobody notices until a customer does.
