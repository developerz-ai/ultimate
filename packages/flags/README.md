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

// with the app's own records in play
if (isEnabled('scraper.persist-profile', actor, { bank: bank.id })) {
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
| `orgs` | org ids that are always on — shorthand for the `org` subject kind, read from `actor.orgId` |
| `subjects` | allow lists for the app's own record kinds: `{ bank: ['bank_integration:bbva'] }` |
| `rollout` | whole percentage 0-100, stable per bucketing subject |
| `bucketBy` | which subject kind the rollout divides: `'actor'` (default), `'org'`, or any kind the call site carries |

Order is allow lists → rollout → default. `actors`, `roles`, `orgs` and `subjects` are one rank —
any hit is `true`. An operator who names a subject is not overruled by a hash. A rollout buckets
`fnv1a(key + ':' + subjectId) % 100`, never `Math.random()`: one subject gets one answer on every
call, in every process, without the nodes talking to each other.

## Subjects — what a flag decides about

A flag decides about an **identified record**: a user, a tenant, a bank integration, a device. The
actor is one subject kind among several, not a privileged one.

| Kind | Where its id comes from |
|---|---|
| `actor` | `actor.id` — spelled `actors` in targeting |
| `org` | `actor.orgId` — spelled `orgs` in targeting |
| anything else | the `subjects` argument at the call site |

```ts
// whole tenants, named — the 90% case, which is why it has a shorthand
targeting: { default: false, orgs: ['org_acme'] }

// 10% of tenants, each one whole
targeting: { default: false, rollout: 10, bucketBy: 'org' }

// the app's own record kind
targeting: { default: false, subjects: { bank: ['bank_integration:bbva'] } }
isEnabled('scraper.persist-profile', actor, { bank: 'bank_integration:bbva' });

// 10% of banks, each bank whole
targeting: { default: false, rollout: 10, bucketBy: 'bank' }
```

`actor` and `org` are resolved from the `Actor` and **never** from the call-site map — one source
per kind, so there is no precedence rule to remember and no second place a tenant can come from.
Every other kind is the app's vocabulary; the kind space is open, exactly like the flag key space.

Bucketing by a record is what keeps it **whole**. An actor-bucketed rollout cuts through a tenant:
3 of an org's 30 members on the new export path and 27 on the old, sharing documents, filing a bug
nobody can reproduce. `bucketBy` puts the whole subject on one side. `'actor'` stays the default,
so every flag declared before this axis answers exactly as it did.

`roles` is deliberately **not** a subject kind: a role is a predicate over the actor, not an
identified record, so it has no id to hash and cannot bucket a rollout.

### A missing subject is an error, not a fallback

If targeting decides by a kind the evaluation context does not carry, `isEnabled()` throws
`X_FLAG_SUBJECT_REQUIRED`. It never falls back to the actor axis or to `default`: an answer about a
record computed from whoever happened to be calling is the exact failure this axis removes, and it
looks like it worked. Every declared kind is resolved before any of them can answer, so the raise
does not depend on the order the keys sit in.

A `null` actor is the one exception and still gets `default` — it says there is no evaluation
context at all, every such call answers alike, and no single subject is split.

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
sorted by key, plus the expired keys lifted out.

**Offered, not published.** Nothing reads it yet: there is no `x flags` command, no `flags` section
in the manifest and no MCP tool, and this file claimed all three until 12.0.0. The manifest is not a
consumer it can ever have — a manifest is derived from source and this reads a registry an app's own
imports fill at runtime — so the one reachable surface is a CLI command, which loads the app first.

## What it owns

| Module | Owns |
|---|---|
| `src/flag.ts` | the two kinds, the compile-time expiry rule, normalisation |
| `src/targeting.ts` | who a flag is on for; declaration-time validation |
| `src/subject.ts` | what a flag decides about — subject kinds and how each resolves to an id |
| `src/bucket.ts` | the stable `(flag, subject)` bucket — FNV-1a, never `Math.random()` |
| `src/registry.ts` | `defineFlag`, key → flag, `applyFlagSnapshot` |
| `src/runtime.ts` | the clock and the per-flag report rate limit over core's `reportError` |
| `src/evaluate.ts` | `isEnabled()` — the one way to ask |
| `src/projection.ts` | `flagsReport()` — the shape a CLI command would print; nothing reads it yet |
| `src/errors.ts` | this package's X_* codes |

## Boundary

Tier 1. May import tiers 0-0 only — enforced by `bun run scripts/boundaries.ts`.

## Errors

`X_FLAG_DUPLICATE` · `X_FLAG_EXPIRED` · `X_FLAG_EXPIRY_INVALID` · `X_FLAG_SUBJECT_REQUIRED` ·
`X_FLAG_TARGETING_INVALID` · `X_FLAG_UNKNOWN`
