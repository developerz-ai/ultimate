# Error codes: `@ultimat3/time`

Part of [Error codes](Error-Codes): every code `@ultimat3/time` registers. `x errors explain <CODE> --json` prints the same row.

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_CRON_INVALID` | not a parseable cron expression | wrong field count | `parseCron('0 3 * * *')` — 5 fields (`m h dom mon dow`) or 6 with seconds |
| `X_CRON_NOT_DESCRIBABLE` | a valid cron expression `describeCron` has no vocabulary for | a 6-field expression whose seconds field says something a 5-field one cannot (`*/10 * * * * *`, `30 0 3 * * *`) — `CronPhrases` has no seconds phrase, so the summary would be wrong | `nextCronOccurrences(expr, zone, from, 3)` to render the real runs, or describe the 5-field schedule the `fix:` line prints — never a summary that drops the seconds |
| `X_DST_AMBIGUOUS` | the local time occurs twice | a fall-back overlap | `fromZoned(wall, zone, { overlap: 'first' })`, or `{ overlap: 'second' }` |
| `X_DST_NONEXISTENT` | the local time does not exist | a spring-forward gap | `fromZoned(wall, zone, { gap: 'next' })`, or `{ gap: 'previous' }` |
| `X_DURATION_INVALID` | not a parseable duration | `'3 days'` | `parseDuration('2h30m')` — `'3d'`, `'250ms'`, or ISO-8601 `PT2H30M` |
| `X_INSTANT_INVALID` | not a parseable instant | a date string with no offset | `fromIso('2026-03-14T09:00:00Z')` — ISO-8601 with `Z` or an offset |
| `X_SCHEDULE_INVALID` | a wall-clock field is out of range | `hour: 24` or `minute: -1` in a schedule spec — `cause` names the field and its range | pass an integer inside the range `cause` prints; wall-clock fields are never wrapped or clamped, because a silently shifted schedule is worse than a failed one |
| `X_TIMEZONE_INVALID` | not an IANA zone | `CET`, `+02:00`, a single-label legacy name like `Japan` or `GB`, or a typo | `Intl.supportedValuesOf('timeZone')` lists every name: use `Area/Location`, or `UTC` — a legacy name swaps mechanically (`Japan` → `Asia/Tokyo`, `GB` → `Europe/London`); an abbreviation does not, because it names no jurisdiction and carries no DST rule |
