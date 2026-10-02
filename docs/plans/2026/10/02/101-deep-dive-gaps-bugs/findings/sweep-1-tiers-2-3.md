# Sweep 1 — tiers 2–3 correctness
> Re-checked in [`sweep-3-verify-backend.md`](sweep-3-verify-backend.md) — where it narrows a row, that file wins.

> Findings for [`../overview.md`](../overview.md). Read-only hunt at `2ea5eb17` (23.0.0), As of 2026-10.
> Scope: `entity`, `policy`, `http`, `auth`, `action`, `query`, `jobs`, `realtime`.
> CONFIRMED = a probe ran. PLAUSIBLE = from reading only.

## Defects

| # | Sev | Where | Defect | Failing input → wrong output | Verdict | Fix direction | Failing-first test |
|---|---|---|---|---|---|---|---|
| 1 | high | `packages/http/src/locale-prefix.ts:28-36` | default-locale redirect copies the unnormalised path remainder into `Location` — open redirect, answered before auth, cacheable 301 | `GET /es-co//evil.example/x` → `301 Location: //evil.example/x`; `GET /es-co/\evil.example` → `//evil.example` | CONFIRMED | run `prefix.path` through `normalizePath` (`packages/http/src/router.ts:152`) | `packages/http/src/locale-prefix.test.ts` |
| 2 | high | `packages/realtime/src/subscriber-gate.ts:214-224`, `cursor.ts:166-173` | a row that becomes visible via UPDATE is forwarded as a partial `update`; the id is never recorded as held | denied at snapshot, then `published: true` → client window `[{id:'1',published:true}]`; server `cursor.ids` stays `[]`; the later `delete` is withheld | CONFIRMED | in `#decide`, visible and `!holds` → promote to `insert` with the whole row through `narrowRow` | `packages/realtime/src/subscriber-gate.test.ts` |
| 3 | high | `packages/query/src/client.ts:212-214` | typed read client encodes a `Date` with JSON quotes and an empty array as nothing | `t.date` field → `X_INPUT_INVALID … received a string of 26 characters`; `{ tags: [] }` → `expected an array, received undefined` | CONFIRMED | `Date` → `toISOString()`; absent declared array reads as `[]` in `coerceQuery`, or `input-shape.ts` refuses a required array | `packages/query/src/client.test.ts`, one round trip in `http.test.ts` |
| 4 | med | `packages/entity/src/memory-unique.ts:37` | memory driver reads `$indexes` only; `invariant(name, c.unique([...]))` is not enforced | second insert with the same `slug` accepted; Postgres answers 23505 | CONFIRMED | build the unique list from the three sources of `uniqueTargets` (`bulk-write.ts:147`) | `packages/entity/src/write-parity.test.ts` |
| 5 | med | `packages/query/src/pagination.ts:85`, `source.ts:100-102` | `Builder.seek` replaces `rowLimit`; paging discards the declared `.limit()` | `.limit(3)` over 10 rows, `.page({}, { first: 5 })` → 5 rows, `hasMore: true`; `?_first=10000` walks past a "top N" | CONFIRMED; intent medium | clamp the seek window to the declared limit, or refuse `.page()` on a limited shape | the suite beside `pagination.ts` |
| 6 | med | `packages/jobs/src/limits.ts:257-259`, `worker-admit.ts:72,109` | `ratePerTenant` stamps at `tryAcquire`; `release()` keeps the stamp — a shed job spends rate | `{limit:3,windowMs:60_000}`: three acquire-release cycles, fourth refused, `blockedBy: rate` | CONFIRMED | a "did not start" release that pops the stamp, or stamp only on `kind: 'run'` | `packages/jobs/src/limits.test.ts` |
| 7 | med | `packages/auth/src/builtin-adapter.ts:135-147` vs `memory-adapter.ts:68-86` | duplicate `register()` answers `X_AUTH_WRITE_FAILED` in memory, `X_DB_UNIQUE_VIOLATION` on Postgres | app branching on the code passes tests, misses in production | PLAUSIBLE | catch 23505 in `BuiltinAdapter.createUser`, rethrow `authUniqueViolation` | `packages/auth/src/adapter-parity.test.ts` |
| 8 | low | `packages/entity/src/memory-match.ts:155-158` | LIKE `_` compiles to `.` without the `u` flag — one UTF-16 unit, not one character | `like '_'` over `a`,`a`,`c`,`😀` → 3 rows; Postgres 4 | CONFIRMED | add `u`, adjust `quote` | `packages/entity/src/write-parity.test.ts` |
| 9 | low | `packages/entity/src/pg-sql.ts:126-127` vs `containment.ts:93` | `has-key` with a non-string operand: Postgres binds `String(value)`, memory answers false | `has-key 1` over `{"1":1}` → 0 rows in memory | memory half CONFIRMED | one rule in both | containment parity suite |
| 10 | low | `packages/jobs/src/driver-memory.ts:325-328` vs `driver-pg-settle-sql.ts:55` | nack with `error` and no `stack` keeps the previous `lastErrorStack` in memory; `SQL_NACK` nulls it | — | PLAUSIBLE | write `lastErrorStack: undefined` when `error` is present | `packages/jobs/src/driver-parity.test.ts` |
| 11 | low | `packages/entity/src/column.ts:243-249` | bad entity name: cause says "not a physical column name", `fix:` is `.column('created_at')` | `entity('probeA', …)` | CONFIRMED | fix names `entity(name, { table })` or a snake_case name | `packages/entity/src/refuse.test.ts` |
| 12 | low | `packages/realtime/src/live-definition.ts:198-204` vs `pg-replication.ts:486` | WAL path stringifies a numeric `id`; snapshot `isRow` requires a string | `integer()` id → "unidentified" at first subscribe | PLAUSIBLE | same normalisation in `rowsOf`, or a refusal naming the numeric id | `packages/realtime/src/live-definition.test.ts` |
| 13 | low | `packages/http/src/request.ts:206` | POST with a body and empty content-type → `bodyRaw()` returns `undefined` | handler sees no body for `{"a":1}`; an all-optional schema validates silently | CONFIRMED | refuse with `bodyInvalid` when bytes are present and no type is declared | `packages/http/src/request.test.ts` |

## Gaps

- No test sends a `Date` or `[]` through the typed query client.
- `adapter-parity.test.ts` never asserts the builtin adapter's thrown code.
- No test for "row becomes visible on update"; gate tests cover visible → denied only.
- `MemoryAdapter.updateUser` enforces neither `external_id` nor `email` uniqueness (reading only).
- `BuiltinAdapter.takeVerification` stamps `consumed_at = now()` from the server clock; memory uses the injected `Clock`.
- `matcher-bridge.ts:41` drops a row whose `orgId` changes — never removed from the old tenant's window. Low confidence: `assertRowTenant` normally refuses tenant moves.
- MCP read tool for a `single: true` query returns the row array; HTTP returns one row or 404.

## Not a bug (do not re-open)

- `memory-repo.ts:96` composite key join — separator is `\x01`.
- Idempotent replay shape across stores — `invoke.ts:267` re-parses through the output schema.
- `withIdempotency` fencing, key namespacing, the 3-attempt reserve loop.
- `base32Encode` / `base32Decode` 32-bit shifts.
- Keyset seek with NULLs, mixed directions, id tiebreak — memory and SQL agree.
- Query matcher move / evict / refill arithmetic.
- Policy `and` / `or` / `not` pre-input gate, `admitsAnonymous`.
- Scheduler `skip`, `run-once`, arming, `maxCatchUp`.
- http rate-limit stage, Postgres take statement, CORS / CSRF, `forwardedElement`, `finalizeCacheHeaders`.
- `pg-array.ts`, `pg-values.ts` text decoding.
- CSV export quoting and formula guard.

## Not read — handed to sweep 2

| Package | Files |
|---|---|
| `realtime` | `socket*`, `sync-*`, `client*`, `record-store`, `offline-queue`, `presence`, `channel*`, `nats-*`, `pg-connection`, `pg-wire`, `pgoutput`, `use-*`, `page-*` |
| `jobs` | `worker`, `worker-run`, `worker-loop`, `outbox*`, `backfill*`, `driver-pg`, operator files, `leases`, `heartbeat`, `events*`, `queue-wake`, `purge`, `job` |
| `auth` | every OAuth file, `jwks`, `id-token`, `password`, `verify`, `workload`, `revocation`, `kdf-gate`, `policy-bridge` |
| `entity` | `expr`, `query`, `pg-driver`, `tenancy`, `sealed*`, `seed`, `relations`, `jit-preload`, `coalesce`, `columns*`, `aggregate`, `count-by`, `search`, `transition` |
| `http` | `error-map`, `error-facts`, `pipeline`, `finalize`, `config`, `security-headers`, `context`, `problem-meta`, `peer-identity` |
| `action` | `openapi`, `openapi-complete`, `audit*`, `registry`, `define-api`, `contract-test`, `sample-input`, `transition`, `mcp-tool`, `job-handle` |
| `query` | `search`, `input-shape`, `subscribes`, `registry`, `record-answer` |
| `policy` | `surfaces`, `decisions`, `test-kit`, `define` |
