# 02 — Record identity from the entity

> Part of [`overview.md`](overview.md). Depends on: 01. Tier: 2.

## Files to change
- `packages/entity/src/` — the `entity()` declaration gains a derived, browser-safe `recordType` (the wire name) and `recordKey(row)` (primary key → string; composite keys joined stably). Derived, never declared twice (axiom 2).
- `packages/entity/src/record-projection.ts` (new, value-light) — `recordProjection(entity)` → `{ type, key, schema, persist }`; `persist` defaults `false` (read by slice 06 — `scripts/config-readers.ts` / `declaration-readers` require a reader).
- `packages/entity/src/index.ts` — named exports.

## Steps
1. Locate the entity declaration and its schema (`codegraph_explore "entity() declaration schema primary key"`).
2. Add `recordProjection`; the key function must reject a row missing its key → new code `X_RECORD_KEY_MISSING` (entity's `errors.ts`, wiki row).
3. Add `persist?: boolean` to the entity options ONLY if slice 06 lands in the same release — a declared-and-never-wired key is the defect `scripts/config-readers.ts` exists for.
4. Server side: expose a `rowsOf(entity, value)` helper action/query use to build the envelope from an output value whose schema references the entity row schema. If schema identity cannot be traced through `t`, stop — see overview risk "Envelope derivation".

## Tests
- `record-projection.test.ts`: composite key stable across key order; missing key → `X_RECORD_KEY_MISSING`; projection is JSON-safe (no functions beyond `key`).
- A browser bundle of `recordProjection` does not pull the Postgres driver (`postgresDriver()`); assert via `bun build --target=browser` in the test.

## Done when
- `bun test packages/entity` green; `bun run boundaries` green (no new edge).
