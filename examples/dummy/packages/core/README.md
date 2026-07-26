# @postly/core

The app's own business services. Three consumers share them: `apps/web`, `apps/admin`, and the
`worker` role. A future `apps/mobile` gets them for free.

Services here take plain values and return plain values. **No HTTP, no rendering, no SQL.** A
service that knows about a request cannot be reused by a job — which is exactly the reuse this
package exists for.

## Public API

| Export | Answers |
|---|---|
| `quoteUpgrade` | what does moving `free → team` mid-cycle cost, in minor units, in this org's currency |
| `assertSeatsAvailable` | may this org add one more member on its current plan |
| `nextDigestAt` | at which UTC instant is it 09:00 in this member's zone, next |
| `localDateIn` | which calendar date is it for this member right now (the digest's idempotency key) |
| `mayPublish` | is this actor allowed to publish this post — the one predicate `policy.ts` wraps |
| `mayInvite` `mayAdministerOrg` | the other two membership predicates |

## Money never leaves minor units

```ts
const quote = quoteUpgrade({ from: 'free', to: 'team', currency: 'USD', daysRemaining: 15, daysInCycle: 30 });
quote.charge; // { minor: 950, currency: 'USD' }
```

Arithmetic happens on integers with an attached currency; `Intl.NumberFormat` runs once, in
`<Money>`, at the edge. Adding two amounts in different currencies throws
`X_MONEY_CURRENCY_MISMATCH` rather than producing a plausible wrong number.

## Timezones are member-scoped, and DST is the test suite

`nextDigestAt` is DST-correct because the tests are written against the transitions, not around
them:

| Member zone | Transition | Local 09:00 becomes |
|---|---|---|
| `Europe/Madrid` | CET → CEST, 2026-03-29 | `08:00Z` → `07:00Z` |
| `Pacific/Auckland` | NZDT → NZST, 2026-04-05 | `20:00Z` → `21:00Z` (southern hemisphere, opposite direction) |
| `Asia/Tokyo` | none | `00:00Z` all year |

See [`src/digest-schedule.test.ts`](src/digest-schedule.test.ts). If you change the scheduling,
those cases are the specification.

## Rules

- Pure functions unless there is a reason. Every export here is `unit`-testable with no fixtures.
- Predicates used by a `policy` live here, so HTTP, live queries, jobs, MCP, and admin evaluate
  the same code. There is exactly one authz definition per rule.
- Never read `Date.now()` inside a service — take the instant as an argument. That is what makes
  the frozen-clock tests honest.
