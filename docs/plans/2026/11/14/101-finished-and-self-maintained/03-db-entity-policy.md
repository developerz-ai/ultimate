# 03 — db, entity, policy, cache, storage

> Part of [`overview.md`](overview.md). Depends on: [`02`](02-core.md). Tier: 1–2.

## Files to change
- `packages/entity/src/` keyset — E1. Nullable keys unsupported (carried, adopter G).
- `packages/entity/src/` chain `.all()` + the `unbounded-read` guard template — E2. A bare `.all()` stops at 50 rows silently; three adopters shipped reads that lost rows. The refusal is parked for `next`; the guard is report-only.
- `packages/entity/src/` tenant proofs — E3. Global reads carry no proof (carried, adopter G).
- `packages/entity/src/` lifecycle counts — E4. `where`, `history(id)`, paced recount (carried from 2026/11/02).
- `packages/policy/src/` `scope` — P1. No OR, cannot follow an entity chain (carried: A5, slice 07 P1 at 75%).
- `packages/db/src/` index DDL + `packages/cli/src/` `x db gen` — D1. No `--drop-redundant` (carried: A2, E9). Production: 115 of 200 indexes never scanned, mostly on empty tables of unused features.
- `packages/cache/src/` `memoPerRequest` — K1. No `forget` (carried, adopter H).
- `packages/storage/src/` boot declaration — S1. The 31.0 re-declaration made every stored object 404 on one production disk and broke a second app; no regression test names it.
- `packages/storage/src/` — S2. Three `NotImplementedError` sites.

## Steps
1. E1: keyset over nullable keys with explicit `nulls first|last` in the cursor; conformance fixture in `packages/testing`.
2. E2: in 31.x, a bare `.all()` whose page filled logs one `X_*` warning with the call site and the guard's fix; the scaffolded guard goes from report to error for new apps. The throw lands on `next` (OD10 of the previous plan; tracked in [`11`](11-compat-and-longevity.md) L1).
3. E3: a global read declares its proof the way a tenant read does; the tenant-proof guard covers both.
4. E4: finish the three lifecycle items as written in `docs/plans/2026/11/02/101-absorb-reinvented-patterns/41-add-entity-lifecycle.md`.
5. P1: `scope` accepts `or` and a declared relation hop, compiled to one statement; proven on the demo's feed read (A5).
6. D1: `x db gen --drop-redundant` emits the drops as a reviewed migration, never by default in 31.x. Measure whether feature tables' indexes can be created when the feature is first registered instead of at install; if it needs a schema-stamp change, record it as a `next` item rather than half-building it.
7. K1: `memoPerRequest(...).forget(key)`.
8. S1: a live test that boots storage twice against a populated disk and reads an old object. S2: implement each stub or delete the port method with its adapter-port row.

## Tests
- `bun test ./packages/entity/src/keyset.test.ts`; live: `./packages/entity/src/keyset.live.test.ts`.
- `bun test ./packages/policy/src/scope.test.ts -t 'or'` — statement count pinned at one.
- `bun test ./packages/storage/src/redeclare.live.test.ts` — fails on the 31.0 behaviour.
- `bun run boundaries`.

## Done when
- The demo's feed read uses `scope` with no over-fetch; its redundant indexes are dropped by a generated migration.
- Zero `NotImplementedError` in `packages/storage/src`.

## Corrections (2026-11-14, found while executing)
- E1 lives in `packages/db/src/keyset.ts`; the entity chain already paged nullable keys.
- E2: the dev warning existed with no code; the guard is `repo-unbounded`, and "error" is the guard with no `severity` line.
- E4: `history(table, id)` had shipped; the counter mirror is `memory-lifecycle.ts`, not `driver-counters.ts`.
- P1: OR/`via` cannot compile to one statement without a predicate tree in `entity` (the chain's `where` was a flat AND list); built entity-first. The demo feed's over-fetch was AND-only and was fixed directly.
- S1: the fix shipped in 31.2 in `cli/src/runtime-storage-boot.ts`; the live proof lives in cli (storage cannot import cli).
