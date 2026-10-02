# Sweep 2 — entity, http, action, query, policy (files sweep 1 left unread)
> Re-checked in [`sweep-3-verify-backend.md`](sweep-3-verify-backend.md) — where it narrows a row, that file wins.

> Findings for [`../overview.md`](../overview.md). Read-only hunt at `2ea5eb17` (23.0.0), As of 2026-10.
> Scope: the "not read" table of [`sweep-1-tiers-2-3.md`](sweep-1-tiers-2-3.md), minus realtime, jobs, auth.
> CONFIRMED = a probe ran. PLAUSIBLE = from reading only. No live Postgres — every "Postgres
> refuses / accepts" half is reasoning from the emitted SQL.

## High

| # | Where | Defect | Failing input → wrong output | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|
| 1 | `packages/entity/src/transition.ts:116-119` | `transitionRow` moves every row in the `from` state when `id` is `undefined` — `namedColumns` (`plan.ts:205`) drops the `undefined` key from the filter | `db.orders.transition('status', undefined, { from: 'pending', to: 'paid' })` with two pending rows → both `paid`, then `X_NOT_FOUND` from the read-back; outside a tx the mass write persists. The action-level `transition()` is shielded by `t.uuid` | CONFIRMED (memory); Postgres shares `updatePlan` | refuse `id === undefined \|\| null` before building the filter, as `update(id, …)` does through `idPlan` | `packages/entity/src/transition.test.ts`, `pg-transition.live.test.ts` |
| 2 | `packages/entity/src/expr.ts:236-250` | `atLeast()` and `eq(<number>)` compare by JS type — always fail on `bigint()` / `decimal()` columns, whose row type is a string | `invariant('nonneg', c.total.atLeast(0))` on `bigint()`, `insert({ total: '5' })` → `X_INVARIANT_VIOLATED`; the emitted CHECK accepts the row. The table is unwritable in both drivers (`$assert` is shared) | CONFIRMED | compare through core's `compareDecimalText`, as `memory-match.ts` does by column kind | `packages/entity/src/expr.test.ts` |

## Medium

| # | Where | Defect | Failing input → wrong output | Verdict | Test |
|---|---|---|---|---|---|
| 3 | `packages/http/src/error-facts.ts:334` | `toProblem` serves the throwable's `fix` even when the document is opaque / hidden | an `EntityError` whose `fix` holds row data, `dev` unset → title and cause blanked, `fix` in the body. `packages/http/CLAUDE.md`: "an unclassified 5xx carries nothing off the throwable". Fix: when hidden, emit `callerFix` or `x errors explain <code>` | CONFIRMED | `packages/http/src/error-facts.test.ts` |
| 4 | `packages/query/src/search.ts:206`, `:164`, `:126` | caller-reachable refusals raised with core `assert` → `X_INVARIANT` → 500 | `?q=%20%20` passes `t.string.min(1)`, fails the trim assert; `?q=a&_first=1` with ≥ 2 matches; a non-null `_after` → opaque 500 to the error monitor. `search.test.ts:178` pins `X_INVARIANT` | CONFIRMED (code + status); HTTP path by reading `http.ts:65-92` | `packages/query/src/search.test.ts` |
| 5 | `packages/entity/src/columns-data.ts:170-171` | `decimal({ precision, scale })` counts a lone leading `0` as an integer digit | `decimal({ precision: 2, scale: 2 }).$parse('0.5')` → "does not fit numeric(2, 2)"; any `numeric(p, p)` column refuses every legal value | CONFIRMED | `packages/entity/src/columns-data.test.ts` |
| 6 | `packages/entity/src/expr.ts:192-200` | `trimmed()` is JS `.trim()` (all whitespace) in the app, `btrim(col)` (spaces only) in SQL | `c.title.trimmed().eq('x')` with `'\tx'` → app accepts, CHECK refuses → raw 23514 instead of `X_INVARIANT_VIOLATED` | CONFIRMED (app + SQL text) | `expr.test.ts`, `pg-invariant-null.live.test.ts` |
| 7 | `packages/entity/src/columns.ts:125-131` | `url()` validates with `new URL` (strips leading whitespace, embedded tabs) but stores the caller's bytes | `'  https://a.b'`, `'ht\ttps://a.b'` stored by memory; the CHECK `~ '^https?://'` refuses them | CONFIRMED (memory) | `packages/entity/src/columns.test.ts` |
| 8 | `packages/policy/src/surfaces.ts:152` | `assertAllowed` always throws `X_FORBIDDEN`, dropping the decision's own code | `assertAllowed(can('post:read'), { actor: null })` → 403; `enforceHttp` answers `X_UNAUTHENTICATED`, which the sign-in redirect keys on. Public export, no in-repo caller. Fix: `codeOf(evaluation.decision)` | CONFIRMED | `packages/policy/src/surfaces.test.ts` |
| 9 | `packages/action/src/transition.ts:118` | input is `id: t.uuid`; `transitionRow` supports non-uuid keys (`singleKeyOf`) | `transition()` over an entity keyed by `text()` / `bigint()` → every call `X_INPUT_INVALID` | PLAUSIBLE | `packages/action/src/transition.test.ts` |

## Low

| Where | Defect | Verdict |
|---|---|---|
| `packages/http/src/config.ts:246` | `input.buildId ?? env('BUILD_ID')` treats an explicit `null` as unset; the doc says `null` disables skew detection | CONFIRMED |
| `packages/entity/src/columns-data.ts:99-100` | `bigint()` has no int8 range check; memory stores what Postgres answers 22003 | CONFIRMED (memory) |
| `packages/entity/src/sealed-column.ts:18-21` | `sealedParse` skips the plaintext parser for any string shaped like a sealed envelope — `text({ max: 5 }).sealed()` accepts a 5,037-char lookalike | CONFIRMED (`$parse`) |
| `packages/entity/src/seed.ts:271-274` | a dry-run `insert` counts every row as inserted; a real replay reports `skipped` | CONFIRMED |
| `packages/action/src/job-handle.ts:54` | job idempotency key is an unkeyed `fingerprint(input)` with no actor or tenant | PLAUSIBLE — jobs dedupe scope unread |
| `packages/action/src/contract-test.ts:76-86` | "OpenAPI document contains its operation" compares one function's output with itself — cannot fail | PLAUSIBLE |
| `packages/entity/src/aggregate.ts:85-86` | `mixedCurrency` handed unit labels — a same-currency scale mix reports "2 currencies (USD, USD@6)" with a fix that leaves the mix | PLAUSIBLE |
| `packages/policy/src/surfaces.ts:65-68` | `HttpDenial` pins `status: 403` when `problem.code` is `X_UNAUTHENTICATED` (latent: nothing renders the status) | CONFIRMED |
| `packages/action/src/openapi.ts:80-93` | published `Problem` schema omits `issues`, `requestId`, `instance`, `meta`; pins `code` to `^X_[A-Z0-9_]+$` while `factsOf` serves any string | PLAUSIBLE |
| `packages/policy/src/decisions.ts:84` | `memoryDecisionSink` unbounded; `audit-memory.ts` was capped for this reason | PLAUSIBLE |
| `packages/policy/src/define.ts:65-70` | a `check` returning `undefined` → bare `TypeError` at `policy.ts:80` (fails closed, not as an `UltimateError`) | CONFIRMED |
| `packages/http/src/config.ts:244` | `hostname` falls back to `env('HOSTNAME')` — the container id under Docker; only a direct `createServer` embedder is exposed | low confidence |

## Gaps

- Sealed lookup columns during key rotation: `sealed-repo.ts:194` allows one as an upsert conflict target while `:205-206` refuses it as a write filter — a row sealed under the retired key would not collide. Not probed, low confidence.
- `sealed-repo.ts:52` passes a non-string sealed value through "so the driver's `$parse` refuses it"; drivers do not `$parse` an `update` patch. Not probed, low confidence.
- `wiki/Error-Codes.md` has no status column — `ERROR_STATUS` cannot be diffed against it mechanically.
- OpenAPI completeness for optional / required, unions, dates, money lives in `json-schema.ts` and `query/src/openapi.ts` — unread.

## Not a bug (do not re-open)

- Deadline race in `pipeline.ts:184-197` — a late handler did not replace the 504 (probed).
- `where({ col: undefined })` — both drivers match nothing.
- Tenancy — `verifyScope` refuses `in`, `is-not-null`, mixed predicates on the tenant column; aggregates, `countBy`, `approximateCount` go through `readPlan`.
- jit-preload / coalesce buckets keyed by `scopeKey` and client, invalidated by a write generation.
- `relationNamed` uses `Object.hasOwn`.
- Audit record on a pre-parse denial; `audit-input.ts` cycles, depth, redaction.
- `derivePath` vs `servedActionRoute` — one function.
- Query path collisions — `router.ts:202` refuses a duplicate at boot (less specific than `X_ACTION_PATH_DUPLICATE`).
- `problem-meta.ts` `wireMeta`; `peer-identity.ts`; `buildCsp`; `sumDecimalText` / `averageDecimalText`.

## Still not read

- `entity`: `sealed-errors`, `aggregate-fold`, `aggregate-decode`, `pg-sql-aggregate`.
- Test suites in scope were not audited for vacuous tests beyond `contract-test.ts:76-86`.
