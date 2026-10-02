# 06 — action, query

> Part of [`overview.md`](overview.md). Depends on: 01, 04. Tier: 3. Path-disjoint from 07, 08.

## Files to change
| Where | Change | Row |
|---|---|---|
| `packages/action/src/mutator.ts:172`, `http.ts:112`, `idempotency.ts:172` | a mutator is replayable by construction: default `idempotent: true`, or refuse one without it at registration (the shape of `assertIdempotencyScope`) | `s1-con #2` |
| `packages/action/src/invoke.ts:274`, `cache-gate.ts:17-22` | `bustAfterCommit` defers to the root commit when `currentTx()` is set — `packages/entity/src/row-observer.ts:210-212` | `s1-con #9` |
| `packages/action/src/idempotency.ts:208-229`, `idempotency-postgres.ts:62-75` | settle on the handler's own transaction connection when one is open (`txExecutor`, as `createPgOutboxStore.stage()`); an in-flight row older than the request deadline is then reclaimable | `s1-con #6` (narrowed in `s3-be`: a design gap) |
| `packages/action/src/audit-input.ts:71` | adopt core's redaction matcher (slice 01) | `s1-sec M2` |
| `packages/action/src/transition.ts:118` | `id` schema from the entity's key, not `t.uuid` | `s2-ehaqp #9` |
| `packages/action/src/contract-test.ts:76-86` | assert against the registry-wide document | `s2-ehaqp` low |
| `packages/action/src/openapi.ts:80-93` | `Problem` schema lists `issues`, `requestId`, `instance`, `meta` | `s2-ehaqp` low |
| `packages/query/src/client.ts:212-214` | `Date` → `toISOString()`; an empty declared array round-trips | `s1-t23 #3` |
| `packages/query/src/pagination.ts:85`, `source.ts:100-102`, `page-controls.ts:28` | the seek window is clamped to a declared `.limit()` | `s1-t23 #5`, `s1-sec L10` |
| `packages/query/src/search.ts:126,164,206` | caller-reachable refusals are `X_INPUT_INVALID`, not core `assert` | `s2-ehaqp #4` |
| `packages/query/src/shape.ts:142` (`compareValues`, `compareNumeric`, `mixed`, `same`, `family`, `normalize`) | **deleted** — resolve column kinds from `QueryShape.entity`, call `compareByKind` / `sameValueOfKind` (`packages/entity/src/memory-match.ts:45`) | `s1-arch #1` (REPRODUCED in `s3-t45`) |
| `packages/query/src/mcp-tool.ts` | a `single: true` query answers one row or not-found, as HTTP | `s1-t23` gaps |

## Steps
1. Comparator first — it is the only deletion here and three other rows read it. Write the parity fixture: one `(kind, left, right)` table through entity's evaluator, query's matcher and — in a `live` test — Postgres. The four disagreeing rows are in `s1-arch #1`; the kind is spelled `'numeric'`. Callers to re-point: `packages/query/src/matcher.ts:61,91,192`, `source.ts:137-140,317`, `pagination.ts:131`. `query → entity` is an existing downward import (`sealed-shape.ts:9`).
2. Mutator idempotency: pick **refuse at registration** unless the owner says default — a silent default needs a scope and a store the app may not have. Either way `examples/dummy/apps/web/app/settings/mutator.ts:30,50` and `posts/mutator.ts:23` must declare it; the demo's `notifications/mutator.ts:33` already does. Fix the claim in `packages/realtime/src/offline-queue.ts:104-107` in the same commit (slice 08 owns that file — coordinate).
3. Tx-aware bust: needs a transaction that reports its outcome — land the 2026-09-28 plan's slice 02 first. Close `wiki/Known-Gaps.md:41` when it ships.
4. Seek clamp: `min(declared, first + 1)`. `packages/query/src/search.ts` has its own workaround — delete it once the clamp lands.
5. Empty arrays: decide in `coerceQuery` (an absent declared array reads `[]`) — the alternative, refusing a required array at `query()`, breaks existing declarations.

## Tests
- `packages/query/src/compare-parity.test.ts` (new) + `compare-parity.live.test.ts`.
- `packages/action/src/mutator.test.ts`; a contract test posting one key twice through `toRoute`.
- `packages/action/src/cache-gate.test.ts` — a fake tx with `onCommit`.
- `packages/query/src/client.test.ts`, `http.test.ts` (round trip), `search.test.ts` (`:178` now pins a 4xx), the pagination suite.
- `bun test packages/action packages/query`

## Owned elsewhere
- Two public `Page` types (`s1-arch #3`) — wire-breaking; slice 15.
- Action → job projection (`s1-arch #4`) — slice 15.
- `toMcpTool` vs `mcp`'s projection (`s2-arch M3`) — slice 14.

## Done when
- A live query ordered on a `bigint()` or `decimal()` column patches rows where the database returns them.
- A replayed mutator applies once. A `Date` and `[]` survive the typed read client.
- `grep -n 'compareValues' packages/query/src` is empty.
- `bun run x -- manifest --check` green in both apps (the OpenAPI `Problem` schema moved); regenerate with `bun run manifest` if the framework manifest drifts.
