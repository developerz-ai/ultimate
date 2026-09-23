# 08 — mcp, ai, mail, notify, pwa, render, ui

> Part of [`overview.md`](overview.md). Depends on: 05. Tier: 4.

Rule: a protocol the framework speaks is spoken to spec. A limit or redactor the docs call
unbypassable is on every path.

## Files to change

| # | Pkg | Defect | File:line | Change | Semver |
|---|---|---|---|---|---|
| a | mcp | `readonly-sql` recognises a dollar-quote tag only as letters and underscores, so `$a1$'$a1$, pg_sleep(2), $a1$'$a1$` passes and runs. `pg_advisory_lock` survives the rollback too | `packages/mcp/src/readonly-sql.ts:348` | Tag regex `/^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/`. Check `db/src/sql-noise.ts` (slice 02 e) | patch |
| b | mcp | `ping` and `prompts/get` answer `-32601`, while `initialize` advertises `prompts` and `prompts/list` lists them | `packages/mcp/src/server.ts:124-141` | `ping` → `{}`. `prompts/get` resolves the name and returns `{ messages }` through an injected reader (the `frameworkResources` pattern). Keep `METHODS`/`classify` in step | minor |
| c | ai | a gateway `budget` is enforced only inside `gateway.scope()`, which nothing calls. `llm()`/`agent()` start from `BudgetLedger({ limits: {} })` | `packages/ai/src/gateway.ts:127-136,158-159`, `llm.ts:257`, `budget.ts` (`request` doc says "one call") | With no `currentBudget()`, reserve against a per-call ledger built from `config.budget`. `llm()`'s root ledger uses the gateway's limits. Fix the `BudgetLimits.request` comment ("one call chain") | minor |
| d | ai | an unknown stop reason (`model_context_window_exceeded`) maps to `end_turn`, so a truncated answer is parsed as complete | `packages/ai/src/wire.ts` `parseStopReason` | Add the member, and map unknown values to `max_tokens` | patch |
| e | ai | `isRetryable` knows only `ETIMEDOUT`/`ECONNRESET`. Bun reports `ConnectionRefused` | `packages/ai/src/gateway.ts:327-341` | Add `ConnectionRefused`, `ConnectionClosed`, `FailedToOpenSocket` | patch |
| f | ai | `agent()` sends tool results to the provider without `configureAi({ redact })` | `packages/ai/src/agent.ts:343`, `agent-transcript.ts:79`, `runtime.ts:29` | Run `aiRedactor()` over each tool result in `toolResultTurn`. Fix the README's "one place" wording | minor |
| g | ai | re-indexing a document that got shorter leaves its old chunks retrievable | `packages/ai/src/rag.ts:157` | Delete `source === id` chunks at index ≥ the new count before the upsert | patch |
| h | ai | duplicate ids in one `upsert`: memory keeps the last, Postgres throws `ON CONFLICT … a second time` | `packages/ai/src/vector.ts:119`, `pg-vector-sql.ts:88` | Dedupe (last wins) in `PgVectorStore.upsert`. Add a parity test | patch |
| i | mail | STARTTLS response injection: bytes appended to the plaintext `220` are read as the TLS-side EHLO reply | `packages/mail/src/smtp-client.ts:210-216`, `smtp-socket.ts:237-256` | After the STARTTLS `220`, refuse `X_MAIL_SEND_FAILED` (stage `starttls`) if the parser, `pending` or the socket queue hold anything, then use a fresh parser (RFC 3207 §4.2) | patch |
| j | mail | Resend's `Idempotency-Key` embeds raw recipients: >256 chars gives a 400 and a dead letter; a non-ASCII address gives a `TypeError`, retried as egress | `packages/mail/src/idempotency.ts:87`, `driver-resend.ts:158` | `mail:<mailId>:<contentDigest(recipients+payload)>` (the `mailMessageIdToken` shape, `:101`) | patch |
| k | mail | a private canonical serializer duplicates core's | `packages/mail/src/idempotency.ts:57` | Import `canonicalJson`. No live defect | patch |
| l | notify | `append` after a window closes replaces the undrained bucket, so the earlier window is lost | `packages/notify/src/digest.ts:82-88` | Seal a closed window under its `endsAt`, with a queue of windows per slot. `drain` takes the sealed one | patch |
| m | pwa | stale-while-revalidate calls `event.waitUntil` after `respondWith` settled, so the throw is swallowed and the refresh can be killed. The harness accepts late `waitUntil` | `packages/pwa/src/strategies.ts:203-208`, `service-worker-harness-fixture.ts:163` | Call `wait(refresh)` synchronously before `return hit`. The harness throws `InvalidStateError` after settle, so the test can fail | patch |
| n | render | `contentHash` is JS FNV-1a over whole documents: 143 µs vs 21 µs for `Bun.hash.xxHash32` on 96 kB | `packages/render/src/render-static.ts:29` | Switch to the native hash. **One-time cache bust**: CHANGELOG note | minor |
| o | render | ISR `descriptorFor` sorts all routes and builds a `RegExp` per dynamic route per regeneration | `packages/render/src/render-isr.ts:234,417` | Compile once per registry revision | patch |
| p | render | stream holes' inline `<script>` bodies are not in `HYDRATE_RUNTIME_BODIES`, so the production CSP blocks them, and hole failures are interpolated into the log message (suspected; no caller passes holes) | `packages/render/src/render-stream.ts:63-73,189,200`, `packages/cli/src/dev-roles.ts:333` | Add the hashes, or refuse `holes` until a caller exists. Log the error as a field | patch |
| q | ui | the backdrop dismiss checks only `click.target`, so a drag-select released on the backdrop closes the dialog (suspected) | `packages/ui/src/components/Dialog.tsx:57` | Require both `pointerdown` and `click` on the backdrop | patch |
| r | ui | `InfiniteScroll` stalls when the sentinel stays visible after `loading` goes false (suspected) | `packages/ui/src/components/InfiniteScroll.tsx:40-50` | Re-check intersection when `loading` flips false | patch |
| s | bundles | non-live islands still ship the error tables (~6.3 kB of `contact-sales`' 20 kB) | islands in `examples/dummy` | Fold into #505's browser-only error tables and widen its scope to action-only islands. Comment on #505; do not duplicate | — |

## Steps
1. Security rows first: a, i, f, j.
2. Each row gets a failing test beside its file. m's test needs the harness change first.
3. n: measure `x build --target static` before and after on `examples/dummy`, and state the numbers in the PR.

## Tests
- `bun test packages/mcp/src packages/ai/src packages/mail/src packages/notify/src packages/pwa/src packages/render/src packages/ui/src`

## Done when
- The two `$a1$` queries are refused.
- A 50-recipient Resend send has a key of 256 chars or fewer.
- The STARTTLS injection probe fails closed.
- `ping` answers `{}`.
