# 11 — action and query: bounded input errors, bounded pages, a lean browser client

> Part of [`overview.md`](overview.md). Depends on: [`02`](02-core-schema.md), [`10`](10-policy-guard.md). Tier: 3 (`action`, `query`). Public `register*` functions are removed in [`29`](29-v31-deletions.md).

## Findings
| # | Sev | Site | Failure | Fix |
|---|---|---|---|---|
| Q1 | **High** | `action/src/validate.ts:26-29` + query twin | unbounded issues (see [`02`](02-core-schema.md) K1) | pass `maxIssues` from schema; problem body carries `issuesTruncated` |
| Q2 | Low–Med (DoS) | `query/src/page-controls.ts:78` using `entity/src/plan.ts:34` (10,000) | `_first=10000` over HTTP/MCP × the per-IP budget (demo: 120/s) | wire cap 500 for HTTP and MCP; `query({ maxPage })` raises it per query; server calls keep 10k |
| Q3 | Low | `query/src/download-token.ts:78-91` | sealed download URL valid for its 5-min TTL after logout or role loss (`TOKEN_IS_THE_GRANT`) | bind the token to the session id hash; a revoked session refuses. README states the TTL |
| Q4 | Low | `action/src/client.ts` → `core-error-codes.ts`, `error-titles.ts` | browser `rpc` = 29.7 KB min / 11.5 KB gz, 108 codes; titles + codes ≈ 27% | import `@ultimat3/core/client` ([`02`](02-core-schema.md) K6); titles server-only; pin `rpc` ≤ 20 KB min |
| Q5 | — | `action/src/policy-gate.ts`, `query/src/policy-gate.ts` + the other twins | duplicated pipeline ([`10`](10-policy-guard.md)) | thin adapters over `guardPrimitive` and core gate shapes |
| Q6 | Low (verify) | `query/src/cache.ts:97` (key `[kind, id, orgId]`) | roles/permissions absent from actor-scoped cache keys; safe only while one id always means one grant set (the demo's shared `dev-agent` id breaks that, dev only) | write the failing test first (two actors, same id, different roles, role-dependent SQL); if it fails, add a grant-set hash to the key |
| Q7 | Low | `action/src/idempotency-memory.ts` | fenced settle is a silent no-op; Postgres logs `action.idempotency.settlement-fenced` | same log line in memory |

## Files to change
- `packages/action/src/validate.ts`, `query/src/validate.ts` (twin) — Q1.
- `packages/query/src/page-controls.ts`, `query.ts` (`maxPage` option) — Q2.
- `packages/query/src/download-token.ts`, `download.ts` — Q3.
- `packages/action/src/client.ts`, `error-titles.ts` (move server-side), a bundle-size pin test — Q4.
- the twin files listed in [`10`](10-policy-guard.md) — Q5.
- `packages/query/src/cache.ts` — Q6. `packages/action/src/idempotency-memory.ts` — Q7.
- `packages/action/README.md`, `packages/query/README.md`, `wiki/Upgrading.md` (Q2 is visible to clients).

## Tests
- `validate.large.test.ts` (both packages): 10k invalid items → ≤ 100 issues, < 20 ms.
- `page-controls.test.ts`: `_first=501` over HTTP → 400 coded; with `maxPage: 2000` → allowed.
- `download-token.test.ts`: token after logout refused.
- `client-bundle.test.ts`: `rpc` build ≤ 20 KB minified, no `png-pixels`.
- `bun test packages/action packages/query`

## Done when
- Each twin pair is either deleted or a < 60-line adapter; the 10k probe is fast; the bundle pin holds.
