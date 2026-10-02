# 04 — entity, policy, http

> Part of [`overview.md`](overview.md). Depends on: 01, 02. Tier: 2. Path-disjoint from 05.

## Files to change
| Where | Change | Row |
|---|---|---|
| `packages/entity/src/transition.ts:116-119` | refuse `id === undefined \|\| null` before the filter, as `update(id, …)` through `idPlan` | `s2-ehaqp #1` |
| `packages/entity/src/expr.ts:236-250` | `atLeast` / `eq(<number>)` compare decimal text through core's `compareDecimalText` | `s2-ehaqp #2` |
| `packages/entity/src/expr.ts:192-200` | `trimmed()` strips U+0020 only, or emits `btrim(col, <set>)` — one rule both sides | `s2-ehaqp #6` |
| `packages/entity/src/columns-data.ts:99-100`, `:170-171` | `bigint()` int8 range; a whole part of `'0'` counts zero digits | `s2-ehaqp #5`, low |
| `packages/entity/src/columns.ts:125-131` | `url()` requires the stored value to match `/^https?:\/\//i` | `s2-ehaqp #7` |
| `packages/entity/src/memory-unique.ts:37` | unique list from the three sources of `uniqueTargets` (`bulk-write.ts:147`) | `s1-t23 #4` |
| `packages/entity/src/memory-match.ts:155-158` | LIKE with the `u` flag; wildcard runs collapsed across separators | `s1-t23 #8`, `s2-sec L7` |
| `packages/entity/src/pg-sql.ts:126-127`, `containment.ts:93` | one `has-key` rule | `s1-t23 #9` |
| `packages/entity/src/column.ts:243-249` | the bad-name refusal names `entity(name, { table })` | `s1-t23 #11` |
| `packages/entity/src/sealed-column.ts:18-21` | `sealValue` calls the unwrapped plaintext parser | `s2-ehaqp` low |
| `packages/entity/src/seed.ts:271-274` | dry-run reads existing keys | `s2-ehaqp` low |
| `packages/entity/src/aggregate.ts:85-86` | `mixedCurrency` distinguishes a scale mix | `s2-ehaqp` low |
| `packages/entity/src/preload.ts:78-95` | a declared ceiling per `hasMany` preload, refused past it | `s2-sec L3` |
| `packages/entity/src/pg-driver.ts:309-313` | a JS-only invariant asserted before the `update` is sent, or the write wrapped | `s2-con` low |
| `packages/policy/src/surfaces.ts:65-68`, `:152` | `assertAllowed` throws `codeOf(decision)`; `HttpDenial.status` follows the code | `s2-ehaqp #8`, low |
| `packages/policy/src/define.ts:65-70` | a non-`true`, non-decision `check` result is `denied` | `s2-ehaqp` low |
| `packages/http/src/locale-prefix.ts:28-36` | `prefix.path` through `normalizePath` (`router.ts:152`) | `s1-t23 #1` |
| `packages/http/src/error-facts.ts:334` | a hidden document emits `callerFix` or `x errors explain <code>`, never `facts.fix` | `s2-ehaqp #3` |
| `packages/http/src/stages.ts:209-226`, `pipeline.ts:56-65` | an IP-keyed bucket spent before `authenticate` | `s1-sec M5` |
| `packages/http/src/peer-identity.ts:89-95` | `trustClientCertHeader`, default off | `s1-sec M6` |
| `packages/http/src/request.ts:206` | body bytes with no declared type → `bodyInvalid` | `s1-t23 #13` |
| `packages/http/src/config.ts:244`, `:246` | `buildId: null` honoured; `HOSTNAME` not a bind default | `s2-ehaqp` low |
| `packages/http/src/pipeline.ts:192`, `server.ts:206-214` | a timed-out handler stays in the in-flight count until it settles | `s1-con` low |
| `packages/http/src/server.ts:292-297` | health routes disclose `buildId` / `inflight` / check names only to an allow-listed peer | `s1-sec L7` |
| `packages/http/src/problem-meta.ts:56,136` | import `hasPublicCause` from core (slice 01) | `s2-sec H1` |

## Steps
1. `transitionRow`: the failing test asserts the row count is **unchanged** and the throw is a refusal, on the memory driver and in `pg-transition.live.test.ts`.
2. Numeric invariants: `$assert` is shared by both drivers — one fix. Add `bigint()` and `decimal()` rows to the invariant parity fixture so memory, emitted CHECK and Postgres agree on `'5' ≥ 0`, `'1.5' = 1.5`.
3. Rate limit before auth: a second bucket keyed on IP only, spent by the `auth` stage's failure path and by the bearer mount. Keep the authenticated bucket where it is. `mcp` (`packages/mcp/src/transport-http.ts:196-201`) is slice 10.
4. Open redirect: assert on the pipeline, not the helper — `GET /<locale>//host/x` answers a same-origin `Location`.
5. XFCC opt-in is BREAKING for an app relying on `trustProxy` alone: CHANGELOG + `wiki/Upgrading.md` row.

## Tests
- Files named per row; `packages/entity/src/write-parity.test.ts` gains the unique-invariant, LIKE and `has-key` cases.
- `packages/http/src/pipeline.test.ts` — twelve anonymous requests to an `auth: 'required'` route against a capacity-3 bucket: the fourth is 429.
- `bun test packages/entity packages/policy packages/http`

## Owned elsewhere
- `packages/http/src/csrf.ts:58`, `navigation.ts:36`, `cache-policy.ts:16`, `deadline.ts:99`, `packages/entity/src/containment.ts:26` — 2026-09-28 plan, slice 03.
- `packages/http/src/stages.ts:449` (Set-Cookie merged by `headers.set` in a loop) — 2026-09-22 plan 102, slice 05. **Live bug; pull it into this slice if that plan stays parked.**
- Two comparators (`packages/query/src/shape.ts:142` vs `packages/entity/src/memory-match.ts:45`) — slice 06.

## Done when
- `transition(…, undefined, …)` changes no row. A `bigint()` column with `atLeast(0)` accepts `'5'`.
- A hidden 5xx problem document carries nothing off the throwable (`packages/http/CLAUDE.md`'s own sentence).
- The reference-app gate stays green — both apps' sign-in flows survive the rate-limit reorder.
