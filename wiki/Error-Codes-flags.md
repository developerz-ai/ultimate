# Error codes: `@ultimat3/flags`

Part of [Error codes](Error-Codes): every code `@ultimat3/flags` registers. `x errors explain <CODE> --json` prints the same row.

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_FLAG_DUPLICATE` | two flags were declared with the same key | a copy-pasted `defineFlag()`, so one of the two declarations decides nothing | rename one of the two `defineFlag({ key: '<key>' })` declarations |
| `X_FLAG_EXPIRED` | a temporary flag is past its expiry and is still being evaluated | scaffolding that outlived the change it was wrapping; `cause` names the owner and how overdue it is | delete the branch and its `defineFlag()` declaration, or move it to `kind: 'permanent'` if it is a real product switch |
| `X_FLAG_EXPIRY_INVALID` | a temporary flag has no usable expiry date | `expiresAt` absent, or not an ISO-8601 date or zoned date-time naming a real day (`'December 1, 2026'`, `'2026-02-30'`, `'2026-12-01T00:00:00'`) — reachable from a store snapshot or plain JS; in TypeScript the union already refuses it | set `expiresAt` to an ISO-8601 date such as `'2026-12-01'` in `defineFlag({ key: '<key>' })` |
| `X_FLAG_SUBJECT_REQUIRED` | a flag decides by a subject the evaluation context does not carry | targeting names a subject kind — an org, or an app record such as `bank` — but the actor carries no `orgId`, or the call site passed no record for that kind. Answered as an error rather than a silent default, which would decide the wrong way and never say so | mint the actor with its tenant — `userActor({ id, orgId })` — for `org`; for an app kind, pass the record at the call site: `isEnabled('<key>', actor, { <kind>: '<id>' })` |
| `X_FLAG_TARGETING_INVALID` | flag targeting is out of range or malformed | `rollout: 0.5` (a fraction read as a percentage means nobody), a rollout outside 0-100, or `default: true` beside a rollout | set `rollout` to a whole percentage 0-100 in `defineFlag({ key: '<key>' })`, and leave `default` false when a rollout decides |
| `X_FLAG_UNKNOWN` | no flag is declared under this key | a typo at the `isEnabled()` call site — answered as an error rather than a silent `false`, which would be a branch that never runs and never says so | declare it with `defineFlag({ key: '<key>', … })`, or correct the key at the call site |

## Notes

### Flags

`X_FLAG_EXPIRED` is the only code in the framework that is **reported and never thrown**: an overdue temporary flag is a debt, not an outage, so `isEnabled()` hands it to the configured `ErrorReporter` as a `warning` (rate-limited to one report per key per hour) and still answers its targeting. Everything else here fails at declaration time.
