# @postly/core

Business services shared by web, admin, and worker. Plain values in, plain values out.

## Boundary

| May import | Must never |
|---|---|
| `@postly/domain`, `@ultimat3/money`, `@ultimat3/time` | `@postly/db`, `@ultimat3/http`, any app, any Solid component |
| — | SQL, `fetch`, rendering, `Date.now()` |

Needs data? Take it as an argument. The caller's `repo.ts` does the loading.

## Files

| File | Owns |
|---|---|
| `src/billing.ts` | plan upgrade quotes + seat limits, minor-unit arithmetic, the billing period |
| `src/digest-schedule.ts` | next 09:00 local per zone, DST-correct; local calendar date |
| `src/membership.ts` | the authz predicates policies wrap |
| `src/errors.ts` | `X_BILLING_SEATS_EXCEEDED`, `X_BILLING_NOT_AN_UPGRADE` |

## Commands

| Task | Command |
|---|---|
| test | `bun test packages/core` |
| one file | `x test unit packages/core/src/digest-schedule.test.ts` |
| typecheck | `bun run --filter @postly/core typecheck` |

## Gotchas

- `quoteUpgrade` returns `{ credit, charge }`; a downgrade throws rather than returning a negative
  charge, because refunds are a different product decision.
- `nextDigestAt` returns the *next* occurrence strictly after the given instant — calling it at
  exactly 09:00 local gives tomorrow, so a retry cannot double-send.
- Day arithmetic is done on local calendar fields and then converted, never by adding 86400000ms.
