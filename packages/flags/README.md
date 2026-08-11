# @ultimat3/flags

Feature flags: permanent switches, and temporary ones that cannot be forgotten.

Feature flags are normally a bad trade — N flags are 2^N states nothing tested. This package takes
the trade only on terms that bound the exponent: every flag declares which of two kinds it is, and
a `temporary` flag carries an expiry it cannot be declared without. Past that date, every
evaluation reports the flag to the app's error monitor and the projection lists it as expired. The
permanent set is a product surface; the temporary set is forced to shrink.

## The two kinds

| Kind | Meaning | Lifecycle rule |
|---|---|---|
| `permanent` | a real product or ops switch — a plan capability, a kill switch, a rollout that became the product | none; it legitimately lives forever |
| `temporary` | scaffolding around an in-progress change | `expiresAt` and `owner` are **required**; past the expiry every evaluation reports `X_FLAG_EXPIRED` |

Omitting `expiresAt` on a `temporary` flag is a **type** error, not a lint rule —
`FlagExpiryIsMandatory` in `src/flag.ts` is a compile-time assertion that fails `tsc` if the union
is ever loosened. `toFlag()` re-checks it at runtime, because a store snapshot and a plain-JS
caller have no types to be checked by.

## Declaring

```ts
import { defineFlag } from '@ultimat3/flags';

export const dunning = defineFlag({
  kind: 'permanent',
  key: 'billing.dunning-emails',
  description: 'ops kill switch for dunning email delivery',
  targeting: { default: true },
});

export const newTaxEngine = defineFlag({
  kind: 'temporary',
  key: 'checkout.new-tax-engine',
  description: 'routes checkout through the rewritten tax engine',
  owner: 'payments',
  expiresAt: '2026-12-01',
  targeting: { default: false, rollout: 10, roles: ['staff'] },
});
```

`defineFlag()` is a `define*` helper, like `defineRoles` and `defineCatalogs`. It is **not** a ninth
primitive: a flag has no handler, no input schema and no surface of its own, so there is nothing for
the registrar to project. The eight primitives stay eight.

## Reading

```ts
import { isEnabled } from '@ultimat3/flags';

if (isEnabled('checkout.new-tax-engine', actor)) {
  // …
}
```

Synchronous, for the same reason `can()` is: this runs inside policy predicates and render passes,
and an `await` there turns every guarded branch into an async boundary. An undeclared key throws
`X_FLAG_UNKNOWN` rather than answering `false` — a typo that reads as "off" is a branch that
silently never runs in production.

## Targeting

| Field | Meaning |
|---|---|
| `default` | the answer when no allow list and no rollout claims this actor |
| `actors` | actor ids that are always on, ahead of any rollout |
| `roles` | actor roles that are always on, ahead of any rollout |
| `rollout` | whole percentage 0-100, stable per actor |

Order is allow lists → rollout → default. An operator who names an actor is not overruled by a
hash. A rollout buckets `fnv1a(key + ':' + actor.id) % 100`, never `Math.random()`: one actor gets
one answer on every call, in every process, without the nodes talking to each other.

## Overrides, out of band

```ts
applyFlagSnapshot({ 'billing.dunning-emails': { default: false } });
```

This is the half that keeps evaluation synchronous. A poller, a job or a realtime channel lands the
store's targeting; `isEnabled()` never loads anything. Keys this build does not declare are
returned in `unknown` rather than thrown — a control plane is routinely ahead of a deploy, and a
kill switch that refuses to land because the payload mentioned tomorrow's flag is one that does not
work on the day it is needed.

## Reporting

There is no reporter seam in this package. An overdue flag goes through `@ultimat3/core`'s
`ErrorReporter` — the framework's one error-monitoring seam — as a `warning` from `source:
'process'`, so an app wires its monitor in exactly one place:

```ts
configureErrorReporting({ reporter: sentryErrorReporter({ dsn }) });
```

What this package adds is the rate limit core has no opinion about: one report per flag per
`DEFAULT_REPORT_INTERVAL_MS` (1 hour), on the **monotonic** clock, so a flag read on every request
does not become the loudest thing in the monitor — which is how a report that fires per call ends
up muted and the debt invisible again. `configureFlags({ clock, reportEveryMs })` tunes it.

## Projection

`flagsReport()` returns every declared flag with its kind, expiry, owner and whether it is expired,
sorted by key, plus the expired keys lifted out. It is the one shape `x flags --json`, an MCP tool
and the manifest should all read, so none of them recomputes "expired".

## What it owns

| Module | Owns |
|---|---|
| `src/flag.ts` | the two kinds, the compile-time expiry rule, normalisation |
| `src/targeting.ts` | who a flag is on for; declaration-time validation |
| `src/bucket.ts` | the stable `(flag, actor)` bucket — FNV-1a, never `Math.random()` |
| `src/registry.ts` | `defineFlag`, key → flag, `applyFlagSnapshot` |
| `src/runtime.ts` | the clock and the per-flag report rate limit over core's `reportError` |
| `src/evaluate.ts` | `isEnabled()` — the one way to ask |
| `src/projection.ts` | `flagsReport()` for the CLI, MCP and the manifest |
| `src/errors.ts` | this package's X_* codes |

## Boundary

Tier 1. May import tiers 0-0 only — enforced by `bun run scripts/boundaries.ts`.

## Errors

`X_FLAG_DUPLICATE` · `X_FLAG_EXPIRED` · `X_FLAG_EXPIRY_INVALID` · `X_FLAG_TARGETING_INVALID` ·
`X_FLAG_UNKNOWN`
