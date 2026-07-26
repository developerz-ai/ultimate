# @postly/domain

Postly's vocabulary. Types, constants, and predicates that every other package agrees on.

**No I/O.** No DB handle, no `fetch`, no `Date.now()`, no environment access. That is what makes
this package importable from a route, a job, a native mobile client, and a test with no setup.

## Public API

| Export | Kind | Notes |
|---|---|---|
| `OrgId` `MemberId` `PostId` `CommentId` | branded string types | a `PostId` cannot be passed where an `OrgId` is expected |
| `MemberRole` `ROLE_RANK` `isAtLeast` | role vocabulary | `owner > admin > author > reader`; policies compare ranks, never string equality |
| `PostStatus` `SLUG_PATTERN` `isValidSlug` `TITLE_MAX` `EXCERPT_MAX` | post invariants | the same predicates the entity's CHECK constraints are generated from |
| `PlanCode` `PLAN_CATALOG` `seatLimit` `priceOf` | plan catalog | prices are `Money` per currency; nothing is converted at runtime |
| `SUPPORTED_LOCALES` `SUPPORTED_ZONES` | member preferences | the closed sets the settings page renders |
| `DomainError` `InvariantViolation` | errors | `X_DOMAIN_INVARIANT` |

## Why it exists

Three consumers need the same rules and cannot share code any other way:

| Consumer | Needs |
|---|---|
| `packages/db` | invariant predicates, to generate CHECK constraints from one source |
| `packages/core` | the plan catalog and role ranks, to do billing and membership math |
| `apps/web` + `apps/admin` + a future `apps/mobile` | the same types on the wire and on screen |

Put a rule here the moment a second package needs it. Do not put it here to "share later" —
an unused export is a guess about the future.

## Rules

- Every price is `{ minor, currency }`. A `number` price does not compile.
- Every id is branded. `string` ids are how tenancy bugs get shipped.
- A predicate here must be total and synchronous — it runs in a CHECK constraint's generated SQL,
  in a browser, and in a job.
