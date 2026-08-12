# 08 — N+1 detection + query instrumentation

> Part of [`overview.md`](overview.md). Depends on: 07 (`preload` is the fix the warning names). Tiers: 1 (`db` observer seam), 2 (`entity` attribution), 5 (`cli`/`admin` surfaces), `testing` (strict fixture).

Bullet's detection + jit_preloader's `n_plus_one_query` event, as a **dev-only diagnostic that the
production path never pays for** (axiom 6). Detection is a `Finding`/`UltimateError`, not a
primitive: a registered `X_*` code with a runnable `fix:` — the exact `.preload('author')` or
`insertAll` line (`X_ERROR_FIX_INVALID` enforces runnability, `packages/cli/src/error-contract.ts`).

Today there is **zero** statement-level instrumentation: no span, no counter, no log
(`packages/db` and `packages/entity` emit no spans at all; the request trace has no DB children
despite `packages/http/src/pipeline.ts:77` claiming otherwise). The proto-detector that exists —
`repeatedSql` in `packages/admin/src/dev/panel-timeline.ts:60-79` — groups by span name and is
blind to repo-level reads. This slice builds the seam both need.

## 1. The observer seam (`db`, tier 1)

- New `packages/db/src/observe.ts`: `interface StatementObserver { onStatement(e: { text, values, durationMs, rows, error?, attribution? }): void }` + `setStatementObserver()` (the `setDbClient` shape, `packages/db/src/client.ts:199-201`). Invoked from the two funnels every statement already passes through: `runOn` (`client.ts:132-141`) and PGlite's `statement()` (`packages/db/src/pglite.ts:125-131`), plus the recording client. Not installed → a `undefined` check, nothing else: prod cost is one branch.
- Emit a span per statement here (`withSpan` from core, already an import) with `db.statement` attribute — `packages/cli/src/dev-traces.ts:94` stops falling back to span names, and the timeline panel's `repeatedSql` starts seeing repo-level SQL.

## 2. Attribution (`entity`, tier 2)

- `postgresRepo` knows what `runOn` can't: entity name + operation (`packages/entity/src/pg-driver.ts:80-163`, plan from `readPlan`/`idPlan`). Thread `{ entity, op }` to the observer — an ALS/ctx slot set around the `client()` call (entity may import db, downward), so the observer's event carries "50× select on `members` via `findById`" instead of raw SQL.

## 3. The detector (`cli` dev-mode, tier 5)

- Installed only by `x dev` (`packages/cli/src/cmd-dev.ts`), never by `serve.ts` (`packages/cli/src/serve.ts:166-168` already draws this line for `/_x`).
- Ledger: per-request `WeakMap<Ctx, Map<fingerprint, count>>`; fingerprint = statement text (already `$n`-normalized) or `entity+op` when attributed. Threshold (default 5 identical shapes per request) → a `Finding`:
  - **Read loop:** `X_N_PLUS_ONE_QUERY` — cause names the entity/op and count; `fix:` is the runnable preload line (relation name derived from 07's relation map when the repeated lookup matches a `references()` FK) or `where('id', 'in', ids)`.
  - **Write loop:** `X_N_PLUS_ONE_WRITE` — repeated single-row insert/update of one shape; `fix:` names `insertAll`/`updateWhere`.
- Codes owned by `entity` (it owns the vocabulary the fix speaks); registered in `packages/entity/src/errors.ts`, rows in `wiki/Error-Codes.md`, `bun run manifest`.
- False positives: deliberate per-item loops exist (`packages/admin/src/search.ts:54-56` argues its own loop is optimal; migrations `packages/db/src/migrate.ts:169`). Suppression is one explicit scope, `expectedQueryLoop(reason, fn)` exported from `db` — no comment pragmas, no config lists (axiom 1). Internal framework loops (migrate, seeds) use it at source.

## 4. Surfaces (all existing channels, nothing new)

| Channel | Wire-up |
|---|---|
| `x dev` findings | append to the `server.findings` getter (`packages/cli/src/cmd-dev.ts:196-200`) — renders in text and `--json` for free |
| Timeline panel | `repeatedSql` (`packages/admin/src/dev/panel-timeline.ts:76`) now fed by statement spans; add threshold + the Finding |
| Browser overlay | `packages/http/src/overlay.ts` renders code/cause/fix when dev — same Finding |
| Logger | one `logger.warn` per request per code, carrying requestId/traceId automatically (`packages/core/src/context.ts:207-210`) |
| Event | mirror jit_preloader's `n_plus_one_query` notification as a telemetry span event, so external subscribers can count them |

## 5. Strict mode (`testing`, tier 5)

- A fixture in `@ultimat3/testing` (the `fixture-jobs.ts:163-167` shape): tests run with the detector in throw mode — an N+1 inside a test fails it (Bullet's `raise`/jit_preloader's RSpec pattern). Opt-in per suite.

## Tests

- Detector: naive posts→authors loop (authored as a fixture in `examples/dummy` per [`05-dummy-app.md`](05-dummy-app.md)) trips `X_N_PLUS_ONE_QUERY` with the exact preload fix line; the `preload` form is quiet; `expectedQueryLoop` silences; write loop trips `X_N_PLUS_ONE_WRITE`.
- Zero-cost: with no observer installed, `runOn` behavior is byte-identical (assert no span, no ledger).
- Attribution: event carries entity+op for repo calls, raw text for hand-written SQL.
- Commands: `bun test packages/db/src/observe.test.ts`, `bun test packages/cli -t 'n+1'`.

## Done when

- Every statement in dev is a span with `db.statement`; the timeline panel counts repo-level repeats; a demonstrable N+1 in the reference app warns with a runnable fix and stops warning when fixed; production path unchanged (one branch); codes registered + documented + `bun run manifest`; `bun run verify` green.
