# 29d — Large tables: bulk writes all-or-nothing

> Part of [`overview.md`](overview.md). Depends on: [`02-db-entity-cancellation.md`](02-db-entity-cancellation.md) (touches `writing()`), order only. Tier: 2 (`entity`).

## Why
**Bulk writes.** `wiki/Entities-And-Migrations.md:395` says "one statement, n rows". Past the bind ceiling it is several autocommits (`entity/src/pg-driver.ts:205`). Reproduced, 40,000 rows, 2 columns, duplicate at row 35,000:

| Driver | Printed |
|---|---|
| Postgres | `X_DB_UNIQUE_VIOLATION`, **32,767 rows left** |
| memory | `X_DB_UNIQUE_VIOLATION`, 0 rows left |

A job retrying that batch meets its own partial write. Three adopters use these calls: 18, 15 and 1 source files.

## Decisions
| Candidate | Outcome |
|---|---|
| Refuse a batch wider than one chunk | no. `insertChunks` exists so a wide batch works (`entity/src/bulk-write.ts:60`) |
| When to open the transaction | only when chunks > 1. One chunk stays one autocommit statement, byte-identical. Inside `withTransaction` the same call is a savepoint |
| `unnest` bulk form | **killed.** 70,000 rows: 639 ms against 1,542 ms chunked. Nobody reported the cost; a second insert path against `wiki/Entities-And-Migrations.md:413` |

## Files to change
- `entity/src/pg-driver.ts:205` — `insertChunks` length above 1: the loop runs inside `postgresTransactor(config)` (`:491`), so a pinned client's scope is the pin's.
- `wiki/Entities-And-Migrations.md:395,413` — states the transaction past the ceiling. `packages/entity/README.md:667`, `packages/entity/CLAUDE.md`, `wiki/Upgrading.md`.

## Steps
1. The transaction, only past one chunk.
2. Retry semantics unchanged: `X_DB_UNIQUE_VIOLATION` propagates from the failing chunk, rollback removes the earlier ones.

## Error codes
None new. `X_DB_UNIQUE_VIOLATION` and friends unchanged.

## Tests
- `entity/src/pg-driver-bulk.live.test.ts`: the probe, 0 rows left; inside an outer `withTransaction` a catch keeps the outer writes. Fails today: 32,767.
- `entity/src/pg-driver-bulk.test.ts`: one chunk sends no `BEGIN`, two do.
- `entity/src/write-parity.test.ts`: the row count after a failed wide batch, both drivers.
- `set -a; . docker/test-services.env; set +a; bun test packages/entity/src/pg-driver-bulk.live.test.ts`

## Semver
minor. A wide batch that failed partway now leaves nothing. Upgrading note for an app relying on partial progress: split the batch yourself.

## Done when
- The 40,000-row probe leaves 0 rows on both drivers.
- `bun run verify` green.
