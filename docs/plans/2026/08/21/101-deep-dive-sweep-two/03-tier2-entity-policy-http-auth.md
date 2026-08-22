# 03 — Tier 2: entity, policy, http, auth

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 2.

## Files to change
- `packages/entity/src/pg-row.ts:109` — `arrayElement` renders any object as `''`. `arrayOf()` (`columns-data.ts:188`) refuses only `money`/`array`, so `arrayOf(json(schema))` and `arrayOf(bytes())` are legal and `sqlTypeOf` (`describe.ts:73`) emits real types for them. **Proven**: `bindValues` → `blobs: '{"",""}'`, `raw: '{""}'`. `memoryRepo` keeps the value, so the loss is production-only. `describe.ts:70`'s "total in practice" comment is the false premise.
- `packages/entity/src/memory-match.ts:55,152-163` — `compareByKind` falls through to `sign(String(left), String(right))`, so `String(null)` is compared as text; `like` does `String(actual)`. **Proven**: `gt/gte/lt/lte/like` against a NULL column match in memory, never in Postgres (`pg-sql.ts` emits `"col" > $1`). `eq/neq/in` are correct and must stay (they compile to `is null` / `is distinct from`).
- `packages/entity/src/columns-data.ts:30` — `json()` doc says "never stringified"; `pg-row.ts:126` stringifies and `pg-sql.ts:267` adds `::text::jsonb`. Rewrite the block to name the pairing.
- `packages/policy/src/errors.ts:50` — `forbidden(label)` emits `x policy explain <label>`; callers (`surfaces.ts:137`, `packages/cli/src/dev-storage.ts:88`) pass `policy.label`, which for a composite renders `and(a:b, c:d)`. **Proven** in `examples/dummy`: `X_DECLARATION_UNKNOWN`.
- `packages/http/src/errors.ts:198` — `forbidden(pathname)` emits `x policy explain <pathname>`; the only reachable callers (`stages.ts:269,273`) fire for page routes with `meta.policy`, whose pathnames are not indexed. **Proven**: `/settings` → `X_DECLARATION_UNKNOWN`.
- `packages/auth/src/rate-limit.ts:64,187` + `packages/cli/src/dev-roles.ts:227` — every limiter and lockout is `scope: 'process'`; `x new` writes `replicas: 2` (`scaffold-helm.ts:71`), the framework chart `3` (`docker/helm/values.yaml:84`). No shared `RateLimitStore`/`AuthLimiter` exists. The derived scope means `X_RATE_LIMIT_NOT_SHARED` can never fire. Mechanism here; the decision on shipping a Postgres store is `12-decisions.md`; the interim warning is slice 07.

## Steps
1. `arrayOf`: refuse `jsonb` and `bytea` elements at declaration (`X_COLUMN_ARRAY_ELEMENT_INVALID` or the existing refusal code `arrayOf` uses for money) — smaller and matches "one scalar literal form"; delete the `describe.ts:70` claim. Encoding them instead is the larger change; do it only if a tracked app needs it (neither does).
2. `memory-match.ts`: copy `packages/query/src/shape.ts:115` — `if (isNull(actual) || isNull(value)) return false;` — into the four ordering cases and `like`.
3. `policy/errors.ts` `forbidden()`: if `label` matches `/^[a-z0-9_-]+:[a-z0-9_-]+$/` keep `x policy explain <label> --json`; else `x policy list --json` (what `X_DECLARATION_UNKNOWN`'s own fix says). The name-interpolating shape is `packages/query/src/errors.ts:78` / `packages/action/src/errors.ts:125`.
4. `http/errors.ts` `forbidden()`: take `route.meta.policy`'s label (or the declaration name) instead of `ctx.url.pathname`; fall back to `x routes --json` when absent — the `bodyInvalid` (`:184`) shape.
5. `auth/rate-limit.ts`: add `RateLimitStore`/`AuthLimiter` structural seams that a Postgres implementation can fill without an `auth → db` edge (`PgExecutor`-style, as `packages/action/src/idempotency-postgres.ts` does). Ship the Postgres implementation if `12-decisions.md` says yes.

## Tests
- `packages/entity/src/columns-data.test.ts` — `arrayOf(json(...))` and `arrayOf(bytes())` refuse at declaration with the named code and a `fix:`.
- `packages/entity/src/memory-match.test.ts` — one NULL case per operator (`gt/gte/lt/lte/like` → false; `eq null` → true; `neq` → false); `.live.` twin in `pg-driver-filtered.test.ts` asserting the same table against Postgres.
- `packages/policy/src/errors.test.ts` — composite label → `x policy list --json`; bare permission → `x policy explain`.
- `packages/http/src/pipeline.test.ts` — a page route with `meta.policy` denied → the emitted `fix` names the policy, not the path.
- Command: `bun test packages/entity/src/memory-match.test.ts packages/entity/src/columns-data.test.ts packages/policy/src/errors.test.ts packages/http/src/pipeline.test.ts`.

## Done when
- Tests fail-then-pass; `bun run scripts/test-fix-citations.ts` (or the gate's `errors` step) resolves every emitted fix; both tracked apps' gates unchanged on their ratchet.
