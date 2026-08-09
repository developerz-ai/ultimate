# @ultimat3/db — agent notes

Tier 1 — it imports `@ultimat3/core` and nothing else, so tier 1 is the lowest its real imports
allow. That placement is load-bearing: `@ultimat3/entity` (tier 2) owns the Postgres driver and
reaches down to this package for it. **Never** import `entity`, `jobs`, `http` or anything higher
— entity snapshots arrive as a parameter (`EntityDescriptionLike`), never as an import.

| Rule | |
|---|---|
| Deps | none (`bun-types` only). Drizzle is documented, not depended on |
| SQL | `sql` binds `$n`; anything non-scalar and non-fragment throws `X_SQL_UNSAFE` |
| Escape hatches | `raw()`, `identifier()`, `literal()` — each call is an audit point |
| Errors | subclass `DbError`; never `throw new Error` |
| New code | add to `DB_ERROR_CODES` **and** `DB_ERROR_TITLES` in `errors.ts` |
| Exports | explicit in `src/index.ts`; no `export *` |
| Files | < 200 LOC, one responsibility, `kebab-case.ts`, test beside source |

Pinned public seam — `@ultimat3/auth`, `@ultimat3/entity` and `@ultimat3/jobs` are written
against these exact names: `SqlFragment`, `sql`, `raw`, `identifier`, `join`, `DbClient`, `DbTx`,
`db`, `setDbClient`, `withTransaction`, `currentTx`. Changing a signature here breaks three
packages — `entity`'s `postgresDriver()` compiles every statement out of `sql`/`identifier`/`join`
and finds its connection through `db()`.

Deliberate cycle (safe — nothing is referenced at module-evaluation time):
`client.ts ⇄ transaction.ts`. `db()` consults `currentTx()`; `withTransaction` uses
`baseClient()`, never `db()`, or it would re-enter itself. Keep both sides `function`
declarations so hoisting covers the TDZ.

The `X_DB_DRIFT` rendering in `drift.ts` and the title in `DB_ERROR_TITLES` are pinned by the
framework contract and duplicated in `@ultimat3/entity`. Change them together or not at all.
`errors.ts` guards `registerErrorCodes` with `hasErrorCode` because `X_NOT_IMPLEMENTED` is core's
and `X_DB_DRIFT` is also declared by entity — registering twice throws at import.

The MCP `db.query` tool is **required** to wrap its client in `readOnly()`.

```bash
bun test                      # from packages/db
bun run typecheck
```

Gotchas:
- `exactOptionalPropertyTypes` — declare optional fields as `x?: T | undefined`.
- `noUncheckedIndexedAccess` — array reads are `T | undefined`; `chunks[i] ?? ''` everywhere.
- Tests use `createRecordingClient()` + `setDbClient()`; no test may need a live database.
- `Bun.SQL` is reached lazily inside `connect()` — importing `client.ts` must not open a socket.
