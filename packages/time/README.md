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

**A zone is `Area/Location`, or `UTC`.** Nothing else. `CET`, `EST5EDT` and `+02:00` name no
jurisdiction and carry no DST rule; the single-label `backward` links (`Japan`, `GB`, `Eire`) are
refused with them, because no rule keeps the first group out and lets the second in. Write the
slashed spelling — `Europe/Paris`, `Asia/Tokyo`, `Europe/London`. `Intl` is not the judge: ICU 78
resolves what ICU 75 threw on, so the check is structural and does not move with the runtime.
**Breaking at 6.0.0**, `Japan` → `Asia/Tokyo`.

One **locale** is one key for the same reason — `Accept-Language` spells one locale `EN-us`,
`en-US` and `en-latn-us`, and `formatDateTime` and `describeCron` collapse the three before they
reach a formatter cache. The cap stays either way: an unknown `-u-` extension value survives
canonicalization as a distinct string, so the key bounds nothing on its own. Both halves —
`canonicalLocale` and `cachedFormatter` — are `@ultimat3/core`'s as of 2.0.0, so `@ultimat3/money`
reads the same bound rather than a copy of it.

`fromIso` refuses a bare local timestamp. `2026-03-14T09:00` names a different instant on every
pod, because `new Date` resolves it through the process's zone — so a clock time reaches an
`Instant` only with `Z` or an offset beside it (`X_INSTANT_INVALID`), and wall-clock input goes
through `fromZoned(wall, zone)`, which names the zone it is stated in.

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

## A calendar date is not an instant

`PlainDate` is `2026-03-14`: a year, a month and a day, with **no time and therefore no zone**,
`As of 2026-08`. The golden rule at the top of this page is about instants — a `PlainDate` needs no
zone because it names no moment, and that is the honest modelling of the values that have one.
`effective_on` is the date a rate applies; a birthday is a date; an invoice period is two of them.
Stored as a `timestamptz`, every one of those is a different date on either side of midnight for
half the planet.

| Function | Answers |
|---|---|
| `plainDate(value)` / `isPlainDate(value)` | the date, or a refusal — `2026-02-30` is not one, and a regex cannot say so |
| `plainDateOf({ year, month, day })` | the same, from fields; an impossible day throws instead of rolling into the next month |
| `plainDateParts(date)` | back to fields |
| `plainDateIn(at, zone)` | the calendar date an **instant** falls on, in a named zone. It takes the zone because there is no other honest way to make this conversion |
| `plainDateUtc(at)` | the date a `Date` holds read as UTC — for the one caller that needs it: a Postgres driver returns a `date` column as midnight UTC |
| `plainDateToUtcInstant(date)` | midnight UTC of the date. The inverse of `plainDateUtc`, and never of `plainDateIn` |
| `addPlainDays(date, days)` / `plainDaysBetween(from, to)` | calendar arithmetic with no zone in it: a DST day is one day, because there is no zone to shorten |
| `comparePlainDates(a, b)` | `-1` / `0` / `1` |

It is a branded **string**, and both halves are load-bearing. Not a `Date`: a `Date` is an instant,
so `2026-03-14T00:00:00Z` is the 13th anywhere west of Greenwich, and binding one to a Postgres
`date` parameter fails outright (`time zone "gmt-0500" not recognized`, measured on 17.10). A
string: the ISO form sorts lexicographically exactly as it sorts chronologically, round-trips
through `JSON.stringify` as itself, and is the literal Postgres accepts and returns.

`@ultimat3/entity`'s `date()` column is the one that stores it.

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
| `X_TIMEZONE_INVALID` | not `Area/Location` or `UTC`: an abbreviation (`CET`), a numeric offset (`+02:00`), or a single-label legacy name (`Japan`) |
| `X_CRON_INVALID` | unparseable expression, or one that can never match |
| `X_DURATION_INVALID` | `'3'` with no unit, trailing junk, unknown unit |
| `X_DST_AMBIGUOUS` | overlap hit with `overlap: 'throw'` |
| `X_DST_NONEXISTENT` | gap hit with `gap: 'throw'` |
| `X_INSTANT_INVALID` | unparseable timestamp |
| `X_LOCALE_INVALID` | a tag `Intl` cannot parse (`en_US`, `''`) reached any entry point taking a `locale`. Declared by `@ultimat3/core` `As of 2026-08`, thrown here unchanged — `@ultimat3/time` owned it until then. It answers **400**, not 500: the `locale` stage negotiates `Accept-Language` and never throws, so a tag that reaches this code came from a path, query or action input the caller wrote |
| `X_CRON_NOT_DESCRIBABLE` | a valid 6-field cron whose seconds field `CronPhrases` has no words for |
| `X_SCHEDULE_INVALID` | a wall-clock field out of range: `slot.hour`, `slot.minute`, `slot.second`, `slot.weekday` |

## Why it exists

Naive time math breaks quietly: the digest goes out an hour early for half the year, the
reminder never fires on the spring-forward day, and nobody notices until a customer does.
