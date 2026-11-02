# 29e — Keyset paging for a raw join

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 1 (`db`), 5 (`cli` guard template).

## Why
A join is the sanctioned exception for raw SQL (`wiki/Entities-And-Migrations.md:221`), and the handle's precise seek (`entity/src/pg-sql.ts:254`, `entity/src/cursor.ts:99`) does not reach it. A `Date` holds milliseconds, the column microseconds, so a naive seek drops rows. Two adopters found that and wrote the same answer: `date_trunc('milliseconds', col)` in the predicate **and** the `order by`, 26 files in one, 3 in the other, one with its own cursor codec beside core's.

The cure defeats the index. Measured 2026-11-02, Postgres 18, 300,000 rows, index on `(created_at desc, id desc)`, `limit 50`:

| Order | Plan | Time |
|---|---|---|
| `date_trunc('milliseconds', created_at) desc, id desc` | Parallel Seq Scan, sort | 100.2 ms |
| `created_at desc, id desc` | Index Only Scan | 0.2 ms |

## Decisions
| Candidate | Outcome |
|---|---|
| Export `seekSql` | no. It needs an entity for column kinds; the point is a raw join across several |
| `keyset()` in `db` | yes. Tier 1, under `query` and `entity`. Core already has the signed codec (`core/src/index.ts:236`) and the page shape (`core/src/index.ts:243`) |
| Second way beside `.after()`? | no, a different surface: `.after()` on the handle, `keyset()` in a raw read. The wiki row says which |
| How microseconds survive | the key is selected as `col::text`, and bound back as `$n::timestamptz`: exact, no arithmetic |
| Nullable keys | refused at the page boundary: a raw reader's null order is its own, and a row comparison has no null order (`entity/src/pg-sql.ts:241`). Handle reads keep theirs |
| Mixed directions | supported: one adopter writes `updated_at desc, id asc`. Uniform is a row comparison, mixed the or-chain, as `entity/src/pg-sql.ts:222` |
| Memory parity | none needed: raw SQL has no memory path. [`17-entity-test-driver.md`](17-entity-test-driver.md) is how it tests |
| Text order differing between memory and a real collation | reproduced: `["10","9","a","A","a b",…]` on `en_US`, `["10","9","A","B","Z","a",…]` in memory, on `.orderBy('name').page()`. `aggregate.ts` already refuses `min` on text for this reason; refusing `orderBy` breaks every list. A documented limit: row in `wiki/Testing.md`, slice 17's route when it matters |

## Files to change
- `db/src/keyset.ts` (new) — `keyset({ scope, keys, after, limit })`, each key `{ column: SqlFragment, kind: 'timestamptz' | 'uuid' | 'text' | 'integer' | 'bigint', direction }`. Answers `{ select, where, orderBy, limit, page(rows) }`: three fragments to splice and `page` returning core's `Page`, the extra row removed and the aliases stripped.
- `db/src/index.ts` — explicit exports.
- `db/src/errors.ts` — the new code; bad cursor stays `CursorInvalidError`, whose `scope` argument pins the query and sort.
- `cli/src/templates/guard-repo-raw-sql.ts:136` and its test — `order by date_trunc('milliseconds', …)` reported; the fix names `keyset()`. App-owned copy, `x doctor` lists the difference.
- `wiki/Entities-And-Migrations.md:215,221` — a row in each table. `wiki/Queries-And-Live-Queries.md`, `wiki/Testing.md`, `wiki/Error-Codes.md`, `packages/db/README.md`, `packages/db/CLAUDE.md`.
- No `examples/dummy` use unless a repo there pages a raw join: a helper, not a primitive feature.

## Steps
1. `bun run new-error-code X_KEYSET_NULL_KEY --package db --title '…' --cause '…' --fix '…' --status 500`.
2. `keyset()`: `after === null` emits `true` as the predicate. Position encoded `[col::text, …]`.
3. Uniform direction `(a, b) < ($1::timestamptz, $2::uuid)`, mixed the or-chain. Binds always cast by `kind`.
4. `page(rows)`: `limit + 1` read, cursor from the last kept row. A null key raises the new code.
5. Guard rule.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_KEYSET_NULL_KEY` (new, `db`, `--status 500`) | a page's last row holds null in a key | `coalesce` the column in the key, or order by a not-null column |
| `X_CURSOR_INVALID` (existing) | a tampered cursor, or another scope's | existing |

## Tests
- `db/src/keyset.test.ts`: fragments per direction; a wrong `scope` refused; null key refused.
- `db/src/keyset.live.test.ts`: 3 rows inside one millisecond across a page boundary, none dropped or repeated, on both directions, Postgres and PGlite (`pg-cursor-precision.live.test.ts` is the model). Plan asserted through `explain`: uses the index, no sort. Mutation: bind through `Date` and the row test fails.
- `cli/src/templates/guard-repo-raw-sql.test.ts`: the rule fires on the literal form, not on a comment.
- `bun test packages/db/src/keyset.test.ts`; `set -a; . docker/test-services.env; set +a; bun test packages/db/src/keyset.live.test.ts`

## Semver
minor. The guard is an app-owned copy: an existing app is told by `x doctor`, its gate does not change until it takes the copy.

## Done when
- The measured query, written with `keyset()`, plans as an Index Only Scan.
- The microsecond-boundary test passes on both engines.
- `bun run verify` green.
