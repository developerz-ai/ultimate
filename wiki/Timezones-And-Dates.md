# Timezones and dates

Store UTC. Format at the edge with `Intl.DateTimeFormat` and an **explicit IANA `timeZone`**.

A `Intl.DateTimeFormat` or `toLocaleString` call with no `timeZone` option is a lint failure and fails `x verify` (check 2). It silently uses the process `TZ`, which in a container is `UTC` and in a laptop is not — the same code renders two different days depending on where it runs.

## Storage

| Rule | Detail |
|---|---|
| Column type | `timestamptz`, always. `timestamp` (without zone) is a build error in a generated migration |
| Stored value | the UTC instant. Postgres normalizes on write; the session `TimeZone` is `UTC` on every role |
| Never stored | a formatted string, a local wall-clock time, or an offset in a separate column |
| Date-only values | `date` column for a true civil date (birthday, invoice date). A `date` has no instant and is never converted |
| Wall-clock intent | when a user means "9am in their city", store `timestamptz` **plus** the IANA zone in its own `text` column. An offset (`+02:00`) is not a zone — it does not survive DST |
| Zone strings | IANA identifiers only: `Europe/Berlin`, `America/Sao_Paulo`. Never `CET`, never `GMT+2`, never `PST` |

## The actor's zone

```ts
import { currentTimeZone } from '@ultimat3/time';
```

| Source | Precedence |
|---|---|
| `user.timeZone` on the profile | 1 — explicit user setting |
| Session-detected zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`, sent at sign-in) | 2 |
| Org / tenant default zone | 3 |
| `app.config.ts` `time.defaultZone` | 4 |
| Process `TZ` | never |

The zone rides the ALS request context alongside the locale, so `format*` helpers take neither argument. Jobs and scheduled tasks carry the enqueueing actor's zone in the payload — a worker has no request and must not invent one.

## Formatting

| Helper | Output | Notes |
|---|---|---|
| `formatDate(instant)` | `2026-07-26` in the actor's zone + locale | `Intl.DateTimeFormat`, `dateStyle: 'medium'` by default |
| `formatTime(instant)` | `14:30` | 12/24h from the locale, never hardcoded |
| `formatDateTime(instant)` | date + time | one formatter, cached per (locale, zone, style) |
| `formatRelative(instant)` | `3 days ago` | `Intl.RelativeTimeFormat`; computed against the frozen clock in tests |
| `formatRange(a, b)` | `Jul 24 – 26, 2026` | `formatRange` on the native formatter, so the collapse rules are CLDR's |
| `formatZone(zone)` | `Central European Summer Time` | `timeZoneName: 'long'` |
| `zonedParts(instant, zone)` | `{ year, month, day, hour, … }` | for arithmetic that must respect civil calendars |

All of them read locale and zone from the context and pass `timeZone` explicitly to `Intl`. There is no variant that omits it.

## Common mistakes

| Mistake | What breaks | Fix |
|---|---|---|
| `new Date().toLocaleDateString()` | uses process `TZ`; wrong day for half your users | `formatDate(instant)` |
| `Intl.DateTimeFormat(locale)` with no `timeZone` | same, and lint-failing | pass `timeZone` or use a helper |
| `timestamp` column | the offset is lost on write; two writers disagree | `timestamptz` |
| Storing `+02:00` as "the zone" | breaks at the next DST transition | store the IANA zone |
| `Date.now()` in a test assertion | flake | `clock.advance('3d')` and assert on the frozen instant |
| `setHours(0, 0, 0, 0)` for "start of day" | midnight in the server's zone, not the user's | `startOfDay(instant, zone)` via `zonedParts` |
| Adding `24 * 60 * 60 * 1000` for "tomorrow" | wrong on the 23h and 25h DST days | add one **calendar** day in the zone |
| `date` column read as an instant | shifts by a day west of UTC | `date` columns are civil dates; never convert |
| Formatting in a service or repo | untestable, unlocalizable | format in the route/component only |

## Duration strings

One notation for every "how long" field.

| String | Means | Used by |
|---|---|---|
| `'30s'` | 30 seconds | cache TTL, retry backoff floor |
| `'15m'` | 15 minutes | `step.sleep`, live-query reconnect window |
| `'6h'` | 6 hours | ISR revalidate TTL |
| `'3d'` | 3 days | `step.sleep`, semantic cache `ttl` |
| `'7d'` | 7 days | LLM semantic cache default |

Parsed once into milliseconds. A bare number is a type error — the unit must be in the string. See [Caching and invalidation](Caching-And-Invalidation) and [Jobs and workflows](Jobs-And-Workflows).

## Scheduled tasks

`tz` is required on every `task` and must be an explicit IANA zone. There is no default.

```ts
// task (cron)
export const nightlyDigest = task({
  cron: '0 3 * * *',
  tz: 'UTC',
  enqueue: () => [[sendDigest, {}]],
});
```

| Concern | Rule |
|---|---|
| Missing `tz` | type error, then `X_CONFIG_INVALID` at boot if bypassed |
| `'UTC'` | correct for machine work: digests, compaction, exports |
| A civil zone | correct for user-facing schedules: "9am local" is `tz: 'Europe/Berlin'`, not `'0 7 * * *'` in UTC |
| Leader election | one `scheduler` role, holding an expiring lease row in `x_scheduler_leader` — never an advisory lock. A task fires once per cluster, not once per pod |
| Catch-up | a missed window is logged and skipped, never replayed silently |

See [Scheduled tasks](Scheduled-Tasks).

### DST-crossing recurrence

| Case | Behavior |
|---|---|
| Spring forward, `0 2 * * *` in a zone that skips 02:00 | the occurrence does not exist; it is skipped for that day and logged |
| Fall back, `0 2 * * *` in a zone that repeats 02:00 | fires **once**, on the first pass. Deduped by the occurrence's civil timestamp |
| `step.sleep('1d')` across a transition | sleeps 24h of elapsed time, not one calendar day. For calendar semantics, compute the next instant in the zone and `step.sleepUntil` |
| Monthly on the 31st | months without a 31st are skipped, not clamped to the 30th. Use `'0 3 28 * *'` if you need every month |

Cron is a civil-calendar schedule; sleeps are elapsed time. Mixing them is where "the job ran twice in November" comes from.

## Tests

| Control | Behavior |
|---|---|
| Frozen clock | time starts at a fixed instant, does not advance on its own |
| `clock.advance('3d')` | moves it, and also drives `step.sleep` and cron dispatch |
| Fixed zone | `UTC` unless a test declares otherwise |
| Fixed locale | `en-US` unless a test declares otherwise |
| tz-dependent bugs | fail deterministically — declare a zone in the test and the bug reproduces every run |
| Wall clock | never asserted on. `Date.now()` in an expectation is a rejected PR |

Declare a zone when the behavior is the point:

```ts
test('digest window respects the org zone', async ({ seed, clock }) => {
  const { org } = await seed('org-in-berlin');
  clock.advance('1d');
  const window = digestWindow(org, 'Europe/Berlin');
  expect(window.label).toBe('Jul 27, 2026');
});
```

See [Testing](Testing).

## Rules

- `timestamptz` for instants, `date` for civil dates. Nothing else.
- Never format without an explicit IANA `timeZone`.
- Never read the process `TZ`. Roles run with `TZ=UTC` and it is not an input.
- Zone comes from the actor; a worker gets it from the job payload.
- Format at the edge only — routes and components, never services or repos.
- Durations are strings with units.
- `tz` on a `task` is explicit and required.
- Advance the frozen clock; never sleep in a test.
