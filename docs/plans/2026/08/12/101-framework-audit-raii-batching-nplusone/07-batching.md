# 07 — Batching: JIT preload, bulk writes, batched iteration

> Part of [`overview.md`](overview.md). Depends on: 02 (single-flight in `query/src/cache.ts`), 06 (disposable cursors). Tier: 2 (`entity`), touches 1 (`db` statement builders stay in `entity`) and 3 (`query` coalescing note).

The rule: **reads and writes batch by default**. Modeled on Rails — `includes`-style preload,
`insert_all`/`upsert_all`-style bulk writes, `in_batches` iteration — plus the sibling-aware JIT
preloading pattern (auto-preload an association for every row loaded together the moment one row
needs it), **globally on, zero ceremony**. No `dataloader()` helper, no opt-in method: the
capability lives inside the existing `Repo`/`ReadBuilder` surface (a facility beneath a primitive,
never a ninth kind — the `readThrough` shape at `packages/query/src/cache.ts:76-96`).

Not a second path (axiom 1): `findById` keeps its signature and gets faster; `preload` is the only
new vocabulary and replaces the phantom `.join()`/`.with()` the reference app already writes
(`examples/dummy/apps/web/app/posts/repo.ts:6-19`).

## Prerequisite: relations become readable

- `ColumnMeta.references` (`packages/entity/src/types.ts:62`) is declared, thunk-resolved once for DDL description (`packages/entity/src/describe.ts:29`), and never read at query time. New `packages/entity/src/relations.ts`: resolve `references()` thunks against the registry (`packages/entity/src/registry.ts`) into a per-entity relation map — `belongsTo` from own FK columns, `hasMany` from inbound ones. No new declaration syntax: the FK already declared is the relation (define once, project everywhere).

## Reads

1. **Per-request id-coalescing.** `postgresRepo.findById` (`packages/entity/src/pg-driver.ts:80-83`) batches point lookups issued in the same microtask window into one `where id in (…)` (the `in` operator exists: `packages/entity/src/pg-sql.ts:35-40`). Per-request store: `WeakMap<Ctx, …>` copying `packages/query/src/cache.ts:59-68` — `entity` cannot import `query` (upward), so it owns its own map; ctx via `tryUseContext` (`packages/core/src/context.ts:131-133`), degrading to no-op without a request.
2. **Sibling-aware JIT preload** (the jit_preloader move — handles sequential `for … await` loops that microtask batching can't). `findMany` tags returned rows with their result set (`WeakMap<row, SiblingGroup>`). When `findById(id)` arrives and `id` matches a `references()` FK value on any sibling row, load the target rows for **all** siblings' FK values in one `in` query into the per-request memo; serve everything after from memory. Scope guards: coalesced statements must carry identical tenancy scope and soft-delete filters as the singles they replace.
3. **Eager `preload`.** `ReadBuilder.preload('<relation>')` (`packages/entity/src/query.ts:12-30`) — declarative form, one extra query per relation (`in` over the page's FK values), rows attached under the relation name. This is the fix the N+1 detector's `fix:` line names. Unknown relation → new `X_PRELOAD_UNKNOWN_RELATION` (entity's registry, `packages/entity/src/errors.ts:44` pattern) with the declared relation names in the fix.
4. **Config:** one switch, `db: { jitPreload: boolean }` in app config, default `true`. No per-query variant.

## Writes

- `insertAll(rows)` — multi-row VALUES; extend `insertStatement` (`packages/entity/src/pg-sql.ts:138-146`).
- `upsertAll(rows, { onConflict })` — `ON CONFLICT DO UPDATE/NOTHING`; the reference app already writes the phantom `.onConflictDoNothing()` for exactly this.
- `updateWhere`/`deleteWhere` already exist (`pg-driver.ts:139-155`) — document them as the bulk forms the detector points at.
- All new methods land on `Repo` (`packages/entity/src/repo.ts:52-73`) + `Table` (`query.ts:32-50`) + **both** drivers; parity pinned in `pg-driver.test.ts` per the two-drivers-one-meaning rule (`packages/entity/CLAUDE.md`), proved against Postgres in `pg-driver.live.test.ts`.

## Iteration

- `ReadBuilder.inBatches(size)` — async iterator over keyset pages via the existing cursor machinery (`packages/entity/src/cursor.ts`, `after` at `query.ts:12-30`). Requires the order-ends-in-unique-key rule already enforced for live queries. Disposable per 06 if it holds a reserved connection.

## Aggregates (in scope)

- `countBy(column, where)` — grouped count over `in`, the `has_many_aggregate` analog; fixes per-row counts like `recountLikes` (`examples/dummy/apps/web/app/posts/repo.ts:72-76`). Both drivers, parity-pinned like the rest.

## Known not-covered

- `@ultimat3/jobs` traffic bypasses `DbClient` via its own `PgExecutor` (`packages/jobs/src/driver-pg.ts:37-39`) — out of scope here; note in docs.
- Memory caveat (jit_preloader's own): sibling groups pin row references for the request's lifetime — bounded because the store is `WeakMap<Ctx>` and dies with the request.

## Tests

- Coalescing: N concurrent `findById` → recording client sees one `in` statement; sequential loop over `findMany` rows → exactly two statements total (the JIT case).
- Parity: memory and pg drivers agree on preload attachment, `insertAll` results, `inBatches` page boundaries.
- Tenancy: coalesced statement carries the tenant scope; cross-tenant ids never coalesce into one query.
- Commands: `bun test packages/entity`, live: `TEST_DATABASE_URL=… bun test packages/entity/src/pg-driver.live.test.ts`.

## Done when

- The reference app's `posts/repo.ts` rewrites cleanly on `preload`/`insertAll`/`upsertAll` (executed in [`05-dummy-app.md`](05-dummy-app.md)); naive loop test cases collapse to ≤2 statements; both drivers pinned; new codes documented + `bun run manifest`; `bun run verify` green.
