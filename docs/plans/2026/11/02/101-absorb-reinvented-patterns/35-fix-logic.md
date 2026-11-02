# 35 — Logic fixes: drivers that disagree, retries refused, wrong bills

> Part of [`overview.md`](overview.md). Depends on: L11 lands in [`07`](07-render-stream-hole.md)'s sweep; L12 before [`18`](18-ai-scripted-and-meter.md). Tier: 1 (`db`, `time`), 2 (`entity`, `auth`), 3 (`action`), 4 (`render`, `ai`).

## Why
All probed 2026-11-02 on Postgres and the memory driver unless marked read. The recurring shape: green in a memory-driver unit test, wrong in production. An agent's first test is the memory one, so each of these lies to it.

## Fixes
| # | Sev | Site | Failure, as printed | Smallest fix | Failing-first test |
|---|---|---|---|---|---|
| L1 | High | `action/src/invoke.ts:279` | delete with row rule, key K: first `{"ok":true}`, retry `X_FORBIDDEN`, runs 1. The row is gone, so the rule judges `null`. A committed write answers its own retry with a refusal | settled record for this key and hash: skip `def.row` and the row predicate, keep the actor's permission check, then replay. In-flight or absent: today's path. The key is already actor-scoped (`idempotencyKeyFor`) | `action/src/idempotency-row.test.ts`: the probe answers the stored value, runs 1; permission revoked between: `X_FORBIDDEN`; other payload: `X_IDEMPOTENCY_CONFLICT` |
| L2 | High | `entity/src/query.ts:490,493` | `update({ s: 'toolong' })` on `text({ max: 3 })`: memory stores it, Postgres `23514`. `update({ s: 42 })`: memory stores `42`, Postgres `"42"`. `insert` parses, `update` does not | `touch(entity, entity.$parsePatch(patch))`: the named columns' schemas, the same issues as `$parse`. An SQL expression value passes untouched | `entity/src/update-parse.test.ts`, both drivers: both patches refused with `insert`'s code; omitted columns untouched; `onUpdateNow` still moves. `transition` covered |
| L3 | Med | `entity/src/pg-sql.ts:63,67,101` | `where({ price: null })` on nullable money: memory `1`, Postgres `X_INVARIANT_VIOLATED`. `price.minor` works on both | `eq`, `neq`, `is-null`, `is-not-null` with a null on a whole money property test `<p>.minor`. A non-null money value stays refused | `entity/src/money-write-parity.test.ts`: the four ops, one count per driver |
| L4 | Med | `entity/src/batch-read.ts:42` | `bigint` id `7`: `findById('007')` `null` alone and batched; `where({ id: '007' }).one()` the row. Filed under the id as written, the row under `'7'` | `keyOf`: integer kinds through `BigInt`, `decimal` through `numericOrder`'s canonical form, unparseable as written so Postgres still answers its own refusal | `entity/src/pg-driver-batch.live.test.ts`: `007`, `+7`, `7` one row; `entity/src/batch-parity.test.ts` |
| L5 | Med | `entity/src/cursor.ts:212` | `orderBy` on `bytes`, Postgres: page 2 **empty, no error**. On `arrayOf`: `22P02` on page 2. On `json`, memory: `TypeError` at `memory-match.ts:65`, Postgres at `cursor.ts:294`. A row count decides when | `assertSeekable` refuses `json`, `bytes`, array kinds, naming the column, as for a bare money property. Its comment already makes the case | `entity/src/cursor.test.ts`: each kind refused at `planFor` with zero rows, on both drivers |
| L6 | Med | `db/src/generate.ts:177-183` | text with a default retyped to integer: `up` fails `42804 default … cannot be cast`, new default or none. Ledger records nothing, deploy stops | when `recorded.default` is set: `drop default` before the `alter type`, reset after unless `column-alter` writes one; `down` mirrored | `db/src/generate-retype.live.test.ts`: apply both directions, both shapes. Today fails on first apply |
| L7 | Med | `action/src/invoke.ts:312` | handler writes then throws: busts delta `0`; clean run `1`. `idempotency.ts:219` treats the same throw as possibly committed, so one path admits the write and the other hides it for the TTL | a `started` flag set in `run`; bust in `finally` when set, not a replay. In a transaction `onCommit` already drops it on rollback | `action/src/cache-gate-tx.test.ts`: throw outside tx busts once; throw in rolled-back tx busts none; `validateInput` refusal busts none; replay busts none |
| L8 | Med | `entity/src/memory-unique.ts:21`, `entity/src/bulk-write.ts:236` | unbounded `decimal()` unique: `'2.5'`, `'2.50'`: memory stores both, Postgres `23505`. `where({ d: '2.500' })` matches 2 in memory, 1 in Postgres | `cellOf` takes the column kind; canonicalises through L4's `keyOf`. `bulk-write.ts` inherits it | `entity/src/column-matrix-parity.test.ts`: both stores refuse; `numeric(10,2)` already refused, stays |
| L12 | Med | `ai/src/gateway.ts:181-183`, `ai/src/run-meter.ts:97` | prompt-cache hit: usage and cost as the original; meter total `inputTokens: 34`. The gateway's own comment says "costs nothing", and it is not debited, so budget and meter disagree | on a hit, `usage` zeros, `cost` and `costExact` zero in the same currency | `ai/src/gateway-cache.test.ts`: miss then hit through `runMeter`, total equals one call; budget unchanged |
| L13 | Med-low | `auth/src/jwks.ts:202` | one published key with no `kid`: `X_OAUTH_EXCHANGE_FAILED`, "no key this runtime can import". `lookup` already handles a kid-less token with one key per algorithm, and such a set never reaches it | file under `:${alg}`. Token with a `kid` still needs its own key | `auth/src/jwks.test.ts`: kid-less set and token verifies; two kid-less keys refused as ambiguous; token naming a `kid` refused |
| L14 | Low-med | `auth/src/oauth-route.ts:391`, `auth/src/oauth-login.ts:344` | read: `:382` calls `credentialsFor(provider, options)` and drops the answer; the exchange re-reads `Bun.env`. `options.env` answers on start, not on callback. `serveApp({ env })` hosts get a 500 | pass `credentials: credentialsFor(provider, options)` | `auth/src/oauth-route.test.ts`: env only in `options.env`, `Bun.env` empty, exchange sees the client id |
| L9 | Low | `action/src/idempotency-postgres.ts:274`, `action/src/idempotency.ts` | handler returned `{ n: 5n }`, store level: memory replays; Postgres uncoded `TypeError`, retry `X_IDEMPOTENCY_CONFLICT`, handler ran. `undefined`: `undefined` then `null` | `withIdempotency` tests the JSON form before settling; unserialisable settles as a failure under the new code, replayed. Memory gains the same test. `undefined` stored `null` is documented: output schema rules | `action/src/idempotency-parity.test.ts`: both stores, same code first and on replay, runs 1 |
| L10 | Low | `time/src/zoned.ts:94,183` | `addDaysInZone(x, 0)`: Europe/Amsterdam second pass moves an hour (`01:30Z` to `00:30Z`); Africa/Monrovia 1960 moves 30 s. `:94` asserts whole-minute offsets | `days === 0` returns `at`. `offsetAt` in seconds, candidate from that; the comment goes | `time/src/zoned.test.ts`: both cases identity; Monrovia round-trips `toZoned` and `fromZoned` |
| L11 | Low | `render/src/render-stream.ts:190` | `resolve` throwing synchronously throws out of `renderStreamHtml` before a byte is sent. Its rejection path exists 3 lines below. Not in `07`, whose `resolve` is its own code; `StreamHole` is public | `Promise.resolve().then(() => hole.resolve(holes.signal))` | `render/src/render-stream.test.ts`: sync throw reveals the error fallback, doc closes |

## Dropped
| Finding | Reason |
|---|---|
| L9, `entity/src/memory-match.ts:97` "parity gaps" | no failing case named or found; `compare-parity.test.ts` holds numeric `=`. Bring a case |

## Order
L4 before L8: one canonical form. L5 before anything paginating a new column kind. Agents by path: `entity/` (L2–L5, L8), `action/` (L1, L7, L9), `db/` (L6), `auth/` (L13, L14, with K7 in [`35-fix-concurrency`](35-fix-concurrency.md)), `ai/` (L12), `time/` (L10), `render/` (L11, in 07's sweep).

## Files
The sites above, tests beside each. `entity/src/entity.ts` for `$parsePatch` (internal, no export from `index.ts`). `wiki/Upgrading.md`, `wiki/Error-Codes.md`, `wiki/Entities-And-Migrations.md`, `packages/entity/README.md` (update validates; refused sort kinds), `packages/ai/README.md`.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_IDEMPOTENCY_OUTPUT_UNSERIALIZABLE` (new) | keyed handler's answer has a `bigint` or a cycle, so no retry could replay it | return JSON from `handle`: `String(id)` for a `bigint`. `bun run new-error-code X_IDEMPOTENCY_OUTPUT_UNSERIALIZABLE --package action --title '…' --cause '…' --fix '…' --status 500` |
| existing | L2 `$parse`'s code; L5 `X_INVARIANT_VIOLATED` | existing |

## Semver
**Breaking, two rows; rest patch.**
- L2 Upgrading: "`update`, `updateWhere` validate named columns. A value `insert` would refuse is refused before the statement, not as `X_DB_STATEMENT_FAILED`. A number written to a text column is an error, not a coercion."
- L5 Upgrading: "`orderBy` on a `json`, `bytes` or array column is refused at plan time. It paged wrongly or threw past page 1. Order by a scalar."
- L1, L3, L4, L6–L14: patch. L12 is observable: a meter reads less. One CHANGELOG line.

## Done when
- A retry of a committed delete replays its answer.
- `bun test packages/entity/src/*parity*.test.ts` covers L2, L3, L8 on both drivers; L5's probe is refused before page 1.
- `generate-retype.live.test.ts` applies a retype over a default both ways.
- `bun run verify`, `bun run scripts/reference-app-gate.ts` green.
