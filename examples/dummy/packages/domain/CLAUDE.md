# @postly/domain

Pure types + constants + predicates. Tier 0 of the app — everything may import it, it imports
nothing app-local.

## Boundary

| May import | Must never |
|---|---|
| `@ultimat3/money` (types + arithmetic, no I/O) | `@postly/db`, `@postly/core`, any app |
| nothing else | `fetch`, `Bun.sql`, `Date.now()`, `process.env`, `Math.random()` |

An I/O import here is `X_BOUNDARY_VIOLATION` in `x verify`.

## Files

| File | Owns |
|---|---|
| `src/ids.ts` | branded id types + constructors |
| `src/roles.ts` | `MemberRole`, rank ordering, `isAtLeast` |
| `src/posts.ts` | post status + slug/title/excerpt invariants |
| `src/plans.ts` | plan catalog, seat limits, per-currency prices |
| `src/preferences.ts` | supported locales + IANA zones a member may pick |
| `src/errors.ts` | `X_DOMAIN_INVARIANT` |

## Commands

| Task | Command |
|---|---|
| typecheck | `bun run --filter @postly/domain typecheck` |
| test | `bun test packages/domain` |

## Gotchas

- Adding a predicate changes generated SQL: run `x db gen` after touching `src/posts.ts`.
- `PLAN_CATALOG` is frozen at module scope. Mutating it is a type error, not a runtime surprise.
