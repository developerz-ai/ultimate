# 04 — Record identity from the entity

> Part of [`overview.md`](overview.md). Depends on: 01. Tier: 2.

## Files to change
- `packages/entity/src/` — the `entity()` declaration gains a derived, browser-safe `recordType` (the wire name) and `recordKey(row)` (primary key → string; composite keys joined stably). Derived, never declared twice (axiom 2).
- `packages/entity/src/record-projection.ts` (new, value-light) — `recordProjection(entity)` → `{ type, key, schema, persist }`; `persist` defaults `false` (read by slice 12 — `scripts/config-readers.ts` / `declaration-readers` require a reader).
- `packages/entity/src/index.ts` — named exports.

## Steps
1. Locate the entity declaration and its schema (`codegraph_explore "entity() declaration schema primary key"`).
2. Add `recordProjection`; the key function must reject a row missing its key → new code `X_RECORD_KEY_MISSING` (entity's `errors.ts`, wiki row).
3. Add `persist?: boolean` to the entity options ONLY if slice 12 lands in the same release — a declared-and-never-wired key is the defect `scripts/config-readers.ts` exists for.
4. **Decided:** `entity()` brands its row schema with a non-enumerable `Symbol.for('ultimate.entity')` → `recordProjection`. Server side, `rowsOf(schema, value)` walks an output schema (object fields, arrays, nullable, union arms) and collects every value whose schema carries the brand. No `records:` option on `action()` — the envelope is derived, never declared (axiom 2). A brand lost through a schema combinator (`.pick`, `.omit`, `.extend`) is NOT an entity row: a partial row must not overwrite a full record — test it.

## Tests
- `rows-of.test.ts`: branded row found at depth (object → array → nullable); `.pick()` of a row not collected; unbranded look-alike not collected.
- `record-projection.test.ts`: composite key stable across key order; missing key → `X_RECORD_KEY_MISSING`; projection is JSON-safe (no functions beyond `key`).
- A browser bundle of `recordProjection` does not pull the Postgres driver (`postgresDriver()`); assert via `bun build --target=browser` in the test.

## Done when
- `bun test packages/entity` green; `bun run boundaries` green (no new edge).
