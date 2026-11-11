# 08 — action and query: pages that reach every row, and three wrappers apps stop writing

> Part of [`overview.md`](overview.md). Depends on: [`01`](01-hotfix-patch.md) (parsed-input cache key), [`05`](05-entity.md) (`.after()` / chain shapes), [`07`](07-auth-policy.md) P1 (`scope`). Tier: 3 (`action`, `query`), with `storage` (tier 1) for Q5 and `testing` (tier 5) for conformance.

## Findings

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| Q1 | **P1** | confirmed (probe: 80 of 100 rows unreachable); one adopter hit it in production ("page two was empty") | `packages/query/src/source.ts:143-156` with `pagination.ts:85-101`; shipped in the reference app: `examples/dummy/apps/web/app/posts/queries/org-posts.ts:17` | A `from(entity, () => repo.fetch(N))` provider never receives the cursor or the window: `execute()` calls `this.rows()` with no arguments, then filters, sorts, cuts and slices those N rows in memory. Page 1: 10 rows, `hasMore: true`. Page 2: 10 rows, `hasMore: false`, `nextCursor: null`. If rows are inserted between requests the provider's window slides past the cursor and page two is empty | `RowProvider`'s function form takes `{ after: SeekKey \| null, limit: number \| null, order: readonly OrderKey[] }`; `Builder.execute()` passes `this.after`, `this.rowLimit`, `servedOrder()` and keeps re-applying filter, sort, cut, slice (idempotent over an already-cut window). A provider that ignores the argument behaves as today. A repository provider pushes it down through the handle's `.after()` or `keyset()` (`packages/db/src/keyset.ts:173`). Enforcement: exercise pages every paginated query twice under the sized seed; a second page that is short while rows remain is `X_QUERY_PAGE_WINDOWED` (lands in [`13`](13-cli-exercise-verify.md)'s sweep) |
| Q2 | P2 | confirmed (read) | `packages/query/src/source.ts:282-285`; `packages/entity/src/memory-match.ts:27-34`; `packages/entity/src/pg-sql.ts` (no `COLLATE`); the parity fixture sidesteps it (`compare-parity-fixture.ts:45-46` declares `text collate "C"`) | The live matcher orders text by code point; Postgres orders by the database's `lc_collate`. On a default `en_US.utf8` cluster a live window ordered by a text column holds `apple, Banana` from SQL while the matcher places an insert by `B < a`: the window misorders and, when full, evicts the wrong row | not a blanket `collate "C"` in emitted SQL: that changes every listing's visible order and stops existing indexes serving the sort. Instead a declaration-time refusal: a **live** query ordered by a text column not declared `collate "C"` is `X_LIVE_ORDER_COLLATION`, fix = declare the column `t.text().collate('C')` (migration generated) or order by a non-text key. Verify first on the local Postgres with a non-C database |
| Q3 | P2 | from [`07`](07-auth-policy.md) P1 | `packages/query/src/read.ts` | policy `scope` not composed | compose the scope predicate into the source before pagination; the rule still runs per row |
| Q4 | P2 | gap (`wiki/Known-Gaps.md`: deferred, 234 wrapper calls); one adopter: 277-line helper, 261 calls, a middleware | `packages/action/src/http.ts` | An action posted by a plain `<form method="post">` has no native answer: no redirect back with a coded refusal | `native: { success: (output) => path, refusal?: (error) => path }` on an action: a non-fetch POST answers 303 to the path, the refusal's code and field issues carried in a flash the next render reads (`useActionAnswer()`). One declaration, the same action still serves fetch clients. `X_NATIVE_FORM_UNANSWERED` (manifest step): an action referenced by a `<form method="post" action>` in a `page.tsx` with no `native` |
| Q5 | P2 | gap; 2 adopters (7 + 2 request/confirm pairs) | `packages/storage/src/` (`grantUpload`, `promoteAttachment` exist) | Every upload slice hand-writes two actions | `uploadFlow({ name, target, accept, maxBytes, policy })` → `{ request, confirm }` actions: a factory over `action` (one `PRIMITIVE_FACTORIES` row). `confirm` sniffs the stored object's type against `accept`, closing the `wiki/Known-Gaps.md` row "a `grantUpload` with a `target` is never sniffed". Home: `packages/action/src/upload-flow.ts` (tier 3 importing `storage`, tier 1: downward) |
| Q6 | P2 | confirmed (read); 1 adopter wrote a group-commit wrapper | `packages/action/src/audit-postgres.ts:126-155`; awaited at `action/src/audit-gate.ts:65,82`, `query/src/audit-gate.ts:159,167` | Each audited call awaits one `INSERT` round trip before its rows return | `batchedAuditSink(sink, { maxRecords, maxDelayMs })` + `writeMany(records)` on the Postgres sink (one `insert … select * from unnest(…)`). Each `write()` resolves with its batch's flush: a rejected flush rejects every waiter, so both failure policies hold (`X_AUDIT_SINK_FAILED`, `X_QUERY_AUDIT_SINK_FAILED`). Flushes on drain. Opt-in: `postgresAuditSink({ groupCommit: true })` |
| Q7 | — | measured out, **not planned** | `packages/query/src/client.ts` | No client batching of several reads into one request | leave: it breaks per-query ETag and HTTP caching, and islands make few calls. In-flight dedupe exists (`clientFlight`) |

Checked and fine, not planned: `pagination.ts` (limits across pages, typed cursors, NULL ordering), `matcher.ts` (refill, eviction position), `live.ts` (per-subscriber authorize, resume, epoch), `mutator.ts` (`idempotent: true` enforced), `withIdempotency` fencing, grant-set in the cache authority key, opt-in ETag (`http-etag.ts`).

Not read in five passes: `action/src/client.ts`, `transition*.ts`, `define-api.ts`, `openapi*.ts`, `meter*.ts`; `query/src/query.ts`, `client.ts`, `http.ts`. Covered by this sweep's review passes ([`overview.md`](overview.md) *Risks*).

## Files to change
- `packages/query/src/source.ts`, `pagination.ts`, `read.ts`, `README.md`, `CLAUDE.md` (the `RowProvider` rule) — Q1, Q3.
- `packages/query/src/live-definition-check.ts` (or where live queries register) — Q2; `packages/entity/src/column.ts` if `.collate()` is not declarable yet.
- `packages/action/src/http.ts`, `native-answer.ts` (new), `action.ts` (definition field); `packages/render/src/` flash read (`use-action-answer.ts`, new; `render` is tier 4, importing `action`: downward) — Q4.
- `packages/action/src/upload-flow.ts` (new), `index.ts`; `packages/core/src/registrar.ts` — Q5.
- `packages/action/src/audit-postgres.ts`, `audit-batch.ts` (new), `adapter.ts`; `packages/testing/src/audit-sink-conformance.ts` — Q6.
- `examples/dummy/apps/web/app/posts/queries/org-posts.ts` + its repository function — Q1 (the reference app ships the bug: fix it in the same PR).
- `wiki/` queries, actions, uploads pages; `wiki/Known-Gaps.md` (close two rows).
- Coordinator only: codes via `bun run new-error-code` (`X_QUERY_PAGE_WINDOWED`, `X_LIVE_ORDER_COLLATION`, `X_NATIVE_FORM_UNANSWERED`), changelog + `wiki/Upgrading.md`, `bun run manifest`.

## Steps
1. Q1 first, failing test from the probe: 100 rows, a top-20 provider, `first: 10`, walk to the end.
2. Q2: reproduce on a database created with `lc_collate 'en_US.utf8'` before deciding; if the local image cannot build one, the live test creates a column with an explicit non-C collation.
3. W1 `query/` (Q1–Q3); W2 Q4; W3 Q5 + Q6; docs worker last.
4. Q4 is the largest design surface: write the `wiki/` page first and have the `architecture-reviewer` agent read it against axiom 1 (it must not become a second way to answer an action) before code.

## Tests
- `packages/query/src/pagination.test.ts` — a window-honouring provider walks all 100 rows over 10 pages; a capturing provider receives `after`/`limit`/`order` on page 2.
- `packages/query/src/compare-parity.live.test.ts` — a `text` column with a non-C collation, rows `apple`/`Banana`: registration refused with the code.
- `packages/action/src/native-answer.test.ts` — a form POST: 303 to `success`; a refusal: 303 back with the code readable by the next render; a fetch POST: unchanged JSON.
- `packages/action/src/upload-flow.test.ts` — one declaration registers two actions; a mismatched content type is refused at `confirm`.
- `auditSinkConformance` over the batched sink; a failed flush rejects all N waiters; a drain flushes.
- Command: `bun test ./packages/query/src/<file>.test.ts`.

## Done when
- No paginated query in any tracked app can lose rows behind a provider window (exercise proves page two).
- The reference app's `org-posts` pages to its last row.
- The three wrappers (form answer, upload pair, audit batching) are deletable in the adopters that wrote them.
