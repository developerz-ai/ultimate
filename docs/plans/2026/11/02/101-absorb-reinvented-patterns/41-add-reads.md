# 41 — A read's freshness: conditional answers, a null's lease, a replica that has caught up, a bound per read

> Part of [`overview.md`](overview.md). Depends on: [`28-assets-stored-objects.md`](28-assets-stored-objects.md) (`etagMatches` in `http`), [`02-db-entity-cancellation.md`](02-db-entity-cancellation.md), [`39-core-breaker.md`](39-core-breaker.md) (same routing check). Owns the read-transaction helper and the `set_config` seam; [`41-add-row-security.md`](41-add-row-security.md) and [`41-add-entity-lifecycle.md`](41-add-entity-lifecycle.md) depend on them. Tier: 1 (`db`), 2 (`http`, `entity`), 3 (`query`), 5 (`cli`).

## Why
| Gap | Evidence |
|---|---|
| A polled read resends every byte | every query route is `no-store` (`query/src/http.ts:125`). Static pages already answer 304 (`wiki/Routes-And-Render-Modes.md:86`); stored objects will (28). Reads are the only GET with no validator, and an API consumer's `If-None-Match` is ignored |
| A null is held as long as a row | `negativeTtlMs` exists and is tested (`cache/src/tiers.ts:83`, `cache/src/negative-ttl.test.ts`), and `query({ cache })` cannot reach it: `query/src/cache.ts:225` passes only `ttlMs` and `tags`, `QueryCache` (`query/src/query.ts:30`) has no such member. A lookup that misses by 40 ms says "does not exist" for 60 s |
| Read-your-writes ends at the request | `scope.wrote` (`db/src/replica-scope.ts:15`) lives for one request (`cli/src/runtime-replica.ts:75`). Write, redirect, read: the next request lands on the standby and the row is gone. Every team running a replica meets this on its first form |
| A read has one time bound | `statement_timeout` is per role (`db/src/libpq-options.ts:71`); only `readOnlyQuery` takes `timeoutMs` (`db/src/readonly-query.ts:31`). A search that must give up at 500 ms and a report allowed 60 s share `web`'s 10 s |

Not here: `If-Match` on actions. `transition({ from })` is optimistic concurrency already (`action/src/transition.ts:132`); a header would be a second way.

## Files to change
- `packages/query/src/query.ts:30` — `QueryCache.negativeTtlMs?`; `query({ etag?: true, timeoutMs? })`.
- `packages/query/src/cache.ts:207-225` — pass `negativeTtlMs` through `readThrough`/`fill`.
- `packages/query/src/http.ts:125` — with `etag: true`: `private, no-cache`, an `ETag`, a bodiless 304.
- `packages/query/src/openapi.ts` — a 304 response and the `If-None-Match` parameter on a declaring read.
- `packages/http/src/cache-policy.ts` — a `private, no-cache` hint; `replayableExchange` (`:71`) already admits 304.
- `packages/db/src/replica-position.ts` (new) — read and compare a WAL position; `replica-client.ts:104` (`nodeIsReplica`) consults it, before the breaker's `admit()`, which stays last ([`39-core-breaker.md`](39-core-breaker.md) step 6): `admit()` consumes the half-open probe, and a read then sent to the primary for being behind would strand it until it lapses.
- `packages/db/src/replica-scope.ts` — `withReplicaReads(fn, { minPosition? })`; the scope's write marks its position after commit.
- `packages/db/src/local-settings.ts` (new) — `setLocal(tx, settings)`: one parameter-bound `select set_config($1, $2, true)`. The only caller of `set_config` in the framework.
- `packages/db/src/read-transaction.ts` (new) — `withReadTransaction(fn, { settings?, client? })` over `withTransaction(fn, { readOnly: true, client })`, then `setLocal`. Row security's standby transaction passes `client: replica`.
- `packages/db/src/statement-bound.ts` (new) — `withStatementTimeout(ms, fn)`: `withReadTransaction` with `statement_timeout`.
- `packages/entity/src/query.ts` — nothing: a repository finds the transaction through `db()`. Stated so nobody adds a chain method.
- `packages/cli/src/runtime-replica.ts:75` — a stage reads and writes the position cookie and header.
- `examples/dummy/apps/web/api/` — one read with `etag: true` and `negativeTtlMs`; one with `timeoutMs`.
- `wiki/Queries-And-Live-Queries.md`, `wiki/Caching-And-Invalidation.md`, `docs/ops/` replica page, `packages/{query,db}/README.md`, `CLAUDE.md`, `wiki/Error-Codes.md`.

## Steps
1. **ETag.** `query({ etag: true })`. Opt-in because it moves a read from `no-store` to the browser's disk: storing a person's rows is a decision per read. Validator: a hash of the serialized body, strong, over bytes the policy already judged. A match is 304 after policy and after the rate limit: a 304 is still a read of that person's rows. `single` and paged reads alike; a download query refuses (`X_QUERY_ETAG_INVALID`), it has its own validators.
2. The browser's own cache revalidates, so `useQuery` needs no code. Test that against `clientTransport`, which must not set `cache: 'no-store'`.
3. **Negative lease.** `cache: { ttlMs, negativeTtlMs }`. Non-positive refused by the tier's rule. An empty list is not a null: only `single: true` answers `null`.
4. **Position.** After a request that wrote commits, read `pg_current_wal_lsn()` once on the primary (only when a replica is configured) and return it as a `__Host-x-pos` cookie and an `x-ultimate-position` header, max age `replica.stickyMs` (default 30 s).
5. On a later request, a read in scope compares against `pg_last_wal_replay_lsn()` on the replica, cached per process for `replica.positionCacheMs` (default 50 ms). Behind, or unknown: the primary. Position values are parsed as `pg_lsn`, never echoed unparsed. A forged position costs the sender a primary read and nothing else.
6. Single-pool client: all of this is off and costs one comparison. Static path untouched (axiom 6).
7. **Bound.** `query({ timeoutMs })` runs its source inside `withStatementTimeout`. A transaction pins to the primary (`db/src/transaction.ts:255`), so **a `timeoutMs` read skips replicas**, and the docs say so. Inside an open transaction the mode cannot change (`transaction.ts:365`), so it sets the bound, runs, and restores the prior value through `setLocal`. A local setting needs a transaction, so it is correct on a transaction-mode pooler ([`29-data-pg-pooler.md`](29-data-pg-pooler.md)). `57014` stays `X_DB_STATEMENT_TIMEOUT` (`db/src/errors.ts:27`). Refused above the role's own bound; a read cannot extend what the role was sized for. No entity option: a table has no time budget, a read does.

## Error codes
`bun run new-error-code` for each new row.

| Code | When | Fix |
|---|---|---|
| `X_QUERY_ETAG_INVALID` (new, off-socket) | `etag: true` on a download or `live` read | remove `etag`; a live read's cursor is its validator |
| `X_QUERY_TIMEOUT_INVALID` (new, off-socket) | `timeoutMs` non-positive or above the role's bound | a whole number of ms under the role's `statement_timeout` |
| `X_DB_STATEMENT_TIMEOUT` (existing) | the bound fired | add the index, or raise `timeoutMs` |

## Tests
- `packages/query/src/http-etag.test.ts`: 200 then 304 with no body; another actor's validator does not match; a denied caller gets 403, never 304; the rate limit spends on a 304. Fails today: no header.
- `packages/query/src/cache-negative.test.ts`: `single` answering `null` is written with `negativeTtlMs`. Fails today.
- `packages/db/src/replica-position.test.ts` over two fake clients: behind goes to primary; caught up to replica; garbage value to primary; no position to replica.
- `packages/db/src/replica-position.live.test.ts`: a real standby is unavailable on the probe box, so a pause of replay is the failure it must prove. Skips with a named reason where no standby exists.
- `packages/db/src/replica-client.test.ts`: behind, then half-open: the read goes to the primary and the probe is unspent.
- `packages/db/src/read-transaction.test.ts`: `grep`-backed: `set_config` appears in `local-settings.ts` alone; `withStatementTimeout` under `withReplicaReads` counts on the primary.
- `packages/db/src/statement-bound.live.test.ts`: `pg_sleep` past the bound answers `X_DB_STATEMENT_TIMEOUT`, and the next read on that connection has the role's timeout back.
- `bun test packages/query/src/http-etag.test.ts`

## Semver
minor. All opt-in, except the position cookie: a new cookie only where a replica URL is set, stated in `wiki/Upgrading.md` as a note.

## Done when
- A declared read answers 304 across a real browser reload in `examples/dummy` e2e.
- A write then redirect, with a paused standby, shows the row.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.
