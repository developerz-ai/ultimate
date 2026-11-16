# Error codes: `@ultimat3/flags`

Part of [Error codes](Error-Codes): every code `@ultimat3/flags` registers. `x errors explain <CODE> --json` prints the same row.

| Code | Means | Typical cause | Fix |
|---|---|---|---|
| `X_FLAG_DUPLICATE` | two flags were declared with the same key | a copy-pasted `defineFlag()`, so one of the two declarations decides nothing | `defineFlag({ key: '<another key>' })` — the key is declared twice: rename one of the two declarations |
| `X_FLAG_EXPIRED` | a temporary flag is past its expiry and is still being evaluated | scaffolding that outlived the change it was wrapping; `cause` names the owner and how overdue it is | `defineFlag({ key: '<key>', kind: 'permanent' })` if it is a real product switch — otherwise delete the branch and its `defineFlag()` declaration |
| `X_FLAG_EXPIRY_INVALID` | a temporary flag has no usable expiry date | `expiresAt` absent, or not an ISO-8601 date or zoned date-time naming a real day (`'December 1, 2026'`, `'2026-02-30'`, `'2026-12-01T00:00:00'`) — reachable from a store snapshot or plain JS; in TypeScript the union already refuses it | `defineFlag({ key: '<key>', expiresAt: '2026-12-01' })` — an ISO-8601 date |
| `X_FLAG_SUBJECT_REQUIRED` | a flag decides by a subject the evaluation context does not carry | targeting names a subject kind — an org, or an app record such as `bank` — but the actor carries no `orgId`, or the call site passed no record for that kind. Answered as an error rather than a silent default, which would decide the wrong way and never say so | `userActor({ id, orgId })` — mint the actor with its tenant, for `org`; for an app kind, pass the record at the call site: `isEnabled('<key>', actor, { <kind>: '<id>' })` |
| `X_FLAG_TARGETING_INVALID` | flag targeting is out of range or malformed | `rollout: 0.5` (a fraction read as a percentage means nobody), a rollout outside 0-100, or `default: true` beside a rollout | `defineFlag({ key: '<key>', targeting: { rollout: 50 } })` — a whole percentage 0-100; leave `default` false when a rollout decides |
| `X_FLAG_UNKNOWN` | no flag is declared under this key | a typo at the `isEnabled()` call site — answered as an error rather than a silent `false`, which would be a branch that never runs and never says so | `defineFlag({ key: '<key>', … })` to declare it, or correct the key at the `isEnabled()` call site |

## Notes

### Flags

`X_FLAG_EXPIRED` is the only code in the framework that is **reported and never thrown**: an overdue temporary flag is a debt, not an outage, so `isEnabled()` hands it to the configured `ErrorReporter` as a `warning` (rate-limited to one report per key per hour) and still answers its targeting. Everything else here fails at declaration time.
