# Feature flags

**Permanent switches, and temporary ones that cannot be forgotten.** Package `@ultimat3/flags`
(tier 1) — the full reference is
[`packages/flags/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/flags/README.md).

N flags are 2^N states nothing tested. This package takes that trade only on terms that bound the
exponent: every flag declares one of two kinds, and a `temporary` flag cannot be declared without an
expiry.

| Kind | Meaning | Lifecycle |
|---|---|---|
| `permanent` | a real product or ops switch — a plan capability, a kill switch | none |
| `temporary` | scaffolding around an in-progress change | `expiresAt` and `owner` are required **by the type**; past the expiry every evaluation reports `X_FLAG_EXPIRED` to the app's error monitor |

`defineFlag()` is a `define*` helper, not a ninth primitive: a flag has no handler, no input schema
and no surface of its own ([The eight primitives](The-Eight-Primitives)).

```ts
import { defineFlag, isEnabled } from '@ultimat3/flags';

export const newTaxEngine = defineFlag({
  kind: 'temporary',
  key: 'checkout.new-tax-engine',
  description: 'routes checkout through the rewritten tax engine',
  owner: 'payments',
  expiresAt: '2026-12-01',
  targeting: { default: false, rollout: 10, roles: ['staff'] },
});

if (isEnabled('checkout.new-tax-engine', actor)) {
  // …
}
```

`isEnabled` is **synchronous**, for the reason `can()` is: it runs inside policy predicates and
render passes. An undeclared key throws `X_FLAG_UNKNOWN` rather than answering `false` — a typo read
as "off" is a branch that never runs in production.

## Targeting

Allow lists first, then the rollout, then `default`:

| Field | Meaning |
|---|---|
| `actors`, `roles`, `orgs` | always on for these ids, roles or tenants |
| `subjects` | allow lists for the app's own record kinds — `{ bank: ['bank_integration:bbva'] }`, read from the call site's third argument |
| `rollout` | whole percentage 0–100, stable per subject: `fnv1a(key + ':' + id) % 100`, never `Math.random()` |
| `bucketBy` | what the rollout divides — `'actor'` (default), `'org'`, or any subject kind, so a tenant is on one side **whole** |

Targeting by a subject kind the call does not carry throws `X_FLAG_SUBJECT_REQUIRED` — never a
fallback to the actor or to `default`.

## Overrides and reporting

`applyFlagSnapshot({ key: targeting })` lands targeting from outside — a poller, a job, a channel —
so evaluation never loads anything. Keys this build does not declare come back in `unknown` rather
than throwing: a control plane is often ahead of a deploy. An overdue flag is reported through
core's one error-reporting seam (`configureErrorReporting`), at most once an hour per flag.

`flagsReport()` projects every flag with its kind, owner and expiry. Nothing reads it yet: no CLI
command prints it and no manifest section carries it.

Codes: `X_FLAG_DUPLICATE`, `X_FLAG_EXPIRED`, `X_FLAG_EXPIRY_INVALID`, `X_FLAG_SUBJECT_REQUIRED`,
`X_FLAG_TARGETING_INVALID`, `X_FLAG_UNKNOWN` — [Error codes](Error-Codes).
