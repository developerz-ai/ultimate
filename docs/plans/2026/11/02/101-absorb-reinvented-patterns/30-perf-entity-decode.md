# 30 — Perf: row decode stops re-deriving column names

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 2 (`entity`).

## Why
`decodeRow` (`entity/src/pg-row.ts:195`) runs `Object.entries` and `columnsOf` per column per row, and `columnsOf` runs `snake` (`entity/src/column.ts:35`), a regex replace plus `toLowerCase`, every time. Column names never change after `entity()`.

Measured 2026-11-02, six-column entity, 100-row list on Postgres, CPU per call, three runs each, loaded box:

| Path | CPU |
|---|---|
| raw `client.query` | 243–266 µs |
| `.orderBy().limit(100).all()` today | 1,064–1,222 µs |
| same, `snake` memoized only | 770–868 µs |
| same, per-entity decode plan | 706–743 µs |

CPU profile of the list today: `snake` 35.6% self, `Object.entries` 11.1%, `decodeRow` 11.1%. After the plan `snake` is 1.5%. Point read, update and insert carry about 100 µs CPU over raw, not worth touching.

Entity overhead that stays is real function: `$parse` per cell, `refuseNul`, uuid validation.

## Files to change
- `packages/entity/src/pg-row.ts:195` — `decodeRow` reads a plan.
- `packages/entity/src/pg-row.test.ts` — new file, the tests below.

## Steps
1. A module-level `WeakMap` keyed on `entity.$columns`, value `readonly [property, column, head, currency, scale][]`, filled from `Object.entries` + `columnsOf` on first decode. Weak, so a test's throwaway entity is not held.
2. The loop body is otherwise unchanged: the `head in source` skip (a `select` narrows the row), the money branch, the sealed branch, the not-null refusal.
3. No `snake` memo. The plan removes its only per-row caller, and a memo is a second cache to reason about.

## Error codes
None. `X_INVARIANT_VIOLATED` for a null in a not-null column is unchanged.

## Tests
- Unit, `pg-row.test.ts`: an entity whose `$columns` is a `Proxy` counting `ownKeys`; two `decodeRow` calls trip it once. Fails on today's code.
- Unit: the plan does not change the answer. A `select`-narrowed row, a three-column and a two-column money, a `.column()`-renamed property, a sealed column, a null in a nullable and in a not-null column.
- `TEST_DATABASE_URL=… bun test packages/entity/src/pg-driver.live.test.ts packages/entity/src/pg-money-write.live.test.ts`.

## Semver
Patch. No API change.

## Done when
- A 100-row list costs at least 30% less CPU than today, on the probe above re-run in the PR.
- `bun test packages/entity` and its live suites green.
