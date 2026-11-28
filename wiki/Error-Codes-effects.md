# Error codes: `@ultimat3/effects`

Part of [Error codes](Error-Codes): every code `@ultimat3/effects` registers. `x errors explain <CODE> --json` prints the same row.

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_EFFECTS_INVALID_VALUE` | effect prop out of range | an @ultimat3/effects component was given a value outside the range it can render (a speed, intensity, count or angle that is negative, not finite, or past its cap) | `<Aurora speed={1} />   // a finite value in the range the effect's props table lists` |
