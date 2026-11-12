# 12 — notify, ai, mcp, pwa: one budget bypass, one recall bug, bounded fan-out

> Part of [`overview.md`](overview.md). Depends on: [`02`](02-schema-core.md) C8 (`mapBounded`). Tier: 4.

## Findings

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| N1 | P2 | plausible (read; not measured) | `packages/notify/src/fanout.ts:151-174`; `native-push.ts:76` | Inside each 500-recipient chunk deliveries run strictly one after another: ledger claim → `channel.deliver` → settle. A 10k audience is ~20k serial database round trips and 10k serial provider calls in one job | `mapBounded` over the chunk (width 16, a constant beside the chunk size in `fanout-walk.ts`), results keyed by recipient, the same ledger claim per recipient. The step stays one per chunk: at-least-once unchanged. Measure first with a fake 50 ms channel |
| AI1 | **P2** | confirmed (code) | `packages/ai/src/gateway.ts:314-317` (`finally` → `ledger.release`), `:309-311`, `:343-344`; `wire.ts:164,241,316` (usage known from `message_start`) | An abandoned or aborted stream releases its whole reservation, though the provider has billed the input tokens and every output token streamed. Starting expensive streams and dropping them after the first chunk spends nothing against `tokensPerRun`, `costPerRun` or the actor and org ceilings; the ledger under-reports | the stream reader exposes running usage (`meta.billed` on any throw once `message_start` arrived — the mechanism `llm()` already uses, `billed.ts`); the gateway **records** partial usage on abandon or abort and releases only when no provider byte arrived. The OpenAI-format reader mirrors it (`openai-wire-stream.ts`) |
| AI2 | P2 | confirmed (code) | `packages/ai/src/pg-vector-sql.ts:70-71` (HNSW), `:149-161` and the hybrid `dense` CTE | Tenant and policy are filtered in SQL on an HNSW scan and nothing sets `hnsw.iterative_scan`: pgvector returns the `ef_search` (40) nearest rows and filters afterwards. A tenant holding a small share of the table gets fewer than `k` hits, often none. The memory store is exact, so dev and production disagree; small live-test tables are scanned sequentially, which hides it | every search in a transaction with `set local hnsw.iterative_scan = relaxed_order` (pgvector ≥ 0.8, version checked at DDL time; otherwise `ef_search = max(40, k × 10)`). The inner `order by distance` stays |
| AI3 | — | owner decision OD8 | `packages/ai/src/` | Media generation (image, audio) through the gateway: absent; one adopter asked. Cross-model fallback is decided out (`packages/ai/CLAUDE.md`); per-run bounds are narrow-only by design; an agent-eval helper exists (`eval-agent.ts`) — that adopter report is stale | decide in [`90`](90-owner-decisions.md). Not planned until decided |
| M1 | P2 | confirmed (read) | `packages/mcp/src/projectable.ts:110-112`; `query-limits.ts:17-23` | A projected query tool returns every row with no row or byte cap (`db.query` is capped at 1,000 rows and 256 KiB): an exposed query with no `.limit()` dumps its result into a model's context | the tool pages through `paginate` with `first: min(MAX_WIRE_PAGE_SIZE, …)` and returns `nextCursor`, under the same byte ceiling, reporting `truncated` |
| M2 | P2 | confirmed (read) | `packages/mcp/src/transport-stdio.ts:74-81`; `server.ts:206` | Stdio lines are handled strictly in sequence: one slow `tools/call` blocks every later frame, `ping` included. `notifications/cancelled` is dropped, so a cancelled call runs to completion | dispatch each request without awaiting it (write order kept by the awaited `write`), a concurrency cap, a `Map<id, AbortController>` that `notifications/cancelled` aborts, the signal passed through `tool.handle(args, caller, signal)` |
| M3 | P3 | confirmed (read) | `packages/mcp/src/transport-stdio.ts:79,83,91` | `lineLimitBytes` is compared against `string.length` (UTF-16 units): a 1 MiB cap admits ~3 MiB of CJK | measure bytes on the raw chunk before decoding |
| M4 | P3 | confirmed (read + production logs) | `packages/mcp/src/audit-hook.ts:70-80`, from `transport-http.ts:276-290` | `mcp.auth.missing-token` logs at `warn` with the raw client address. MCP's own OAuth discovery starts unauthenticated: every legitimate client's first connect writes a warn line carrying a full IP | `info` for `missing-token` (`warn` stays for `rejected-token` and `throttled`); log `addressNetwork(address)`, the key the limiter already uses |
| W1 | P3 | confirmed | `packages/pwa/src/service-worker.ts:284-292`; `strategies.ts:160`; `version-skew.ts:71` | Inside one build the `x-pages-<id>` cache keeps every document visited: no entry bound, only the next deploy and the browser's quota | cap entries per pages cache (50, oldest evicted by `cache.keys()` order) in the emitted put path; the TS mirror kept in step (`pages-cache-source.ts`) |

Checked and fine, not planned: notify preferences batched per chunk, push collapse ids; ai bounded tool fan-out, atomic budget `take`, signal forwarded to `fetch`, jittered backoff, embeddings batched; mcp `readonly-sql.ts` (multi-statement, `set`/`copy`/`into`, comment tricks, side-effecting call families, `FOR UPDATE` all refused), remote-tool fence, `tools/list` cost; pwa network-first documents, never caching a per-member document; mail SMTP backpressure and the STARTTLS guard; scraping SSRF screen.

Not read in five passes: `mcp` `meta-*`, `validate-args.ts`, `oauth-*`; `ai` providers' bodies, `agent*.ts`, `rag.ts`, `hive*.ts`; `pwa` push; `scraping` CDP driver; `mail` drivers other than SMTP; `notify` ledger, inbox, digest. Covered by this sweep's review passes ([`overview.md`](overview.md) *Risks*).

## Files to change
- `packages/notify/src/fanout.ts`, `fanout-walk.ts` — N1.
- `packages/ai/src/gateway.ts`, `wire.ts`, `openai-wire-stream.ts`, `anthropic-provider.ts`, `openai-provider.ts`, `billed.ts` — AI1. `pg-vector.ts`, `pg-vector-sql.ts` — AI2.
- `packages/mcp/src/projectable.ts`, `query-limits.ts`, `transport-stdio.ts`, `server.ts`, `registry.ts`, `audit-hook.ts` — M1–M4.
- `packages/pwa/src/pages-cache-source.ts`, `strategies.ts`, `service-worker.ts` — W1.
- Each package's `README.md`/`CLAUDE.md` where a contract line moves.
- Coordinator only: changelog + `wiki/Upgrading.md` (AI1 makes aborted streams count against budgets: a behaviour change apps must hear; M1 truncates), `bun run manifest`.

## Steps
1. AI1 and AI2 first, each with a failing test; they are the two correctness defects.
2. W1 `ai/`; W2 `mcp/`; W3 `notify/` + `pwa/`.
3. AI2's live test must force the index (`set enable_seqscan = off`) on a 10k-row table where the target tenant holds 50 rows, or it proves nothing.
4. M2 changes `tool.handle`'s signature: additive third parameter; every in-repo tool gets the signal threaded in the same PR.

## Tests
- `packages/ai/src/gateway.test.ts` — scripted SSE: `message_start` with input 1,000, break after one delta → the ledger records ≥ 1,000; an abort before any byte → released.
- `packages/ai/src/pg-vector.live.test.ts` — `search(k = 10)` returns 10 for the small tenant with the index forced.
- `packages/mcp/src/app-security.test.ts` — a 5,000-row exposed query returns ≤ the cap with `truncated: true`. `transport-stdio.test.ts` — a slow tool then a `ping`: `ping` answers first; a cancelled call's signal aborts; 400k `'中'` refused at 1 MiB.
- `packages/notify/src/fanout-chunks.test.ts` — 500 recipients on a 50 ms channel finish well under 25 s; max in flight ≤ 16; a failing recipient does not stop its neighbours.
- `packages/pwa/src/service-worker-runtime.test.ts` — 60 page visits leave 50 entries, the newest kept.
- Command: `bun test ./packages/<pkg>/src/<file>.test.ts`.

## Done when
- A dropped stream costs what the provider billed.
- A small tenant's vector search returns `k` hits on a large shared table.
- An MCP client can cancel, is never blocked behind a slow call, and never receives an unbounded result.

## Outcome (sweep 11, local)

Ships as 31.15.0. `As of 2026-11-12`, measured before release.

| ID | Outcome |
|---|---|
| N1 | reproduced, then shipped. 16 at a time inside a chunk (`NOTIFY_DELIVERY_WIDTH`), each with its own claim; one failing recipient no longer stops its chunk. 100 recipients on a 50 ms channel 5.1 s → 0.36 s. The concurrency review found `mapBounded` rejecting at once on a drain with sends in flight (rows left `sending`, re-sent after the reclaim window): replaced by `fanout-pool.ts`, which stops claiming on abort and settles every started send first (`fanout-drain.test.ts`). Also: the Postgres inbox `add` returns the stored row under a concurrent writer; `memoryDeliveryLedger` no longer evicts a just-reclaimed row |
| AI1 | shipped, widened by the security review. A stream that stops after the provider's first byte records the running usage (`stream-bill.ts`); a `generate` or `stream` aborted after its request was sent records the prompt's estimate (`trackSent`); only a call never sent, or refused by the provider, releases. A `done` whose record throws is never re-booked (the concurrency review: double cost). A non-streamed 2xx that is not a JSON object or is over 32 MiB is `X_AI_PROVIDER_UNAVAILABLE` (`answer-body.ts`) |
| AI2 | shipped. `pg-vector-recall.ts`: `hnsw.iterative_scan = relaxed_order` on pgvector ≥ 0.8, else `ef_search = max(40, k × 10)` capped at 1,000, version read in the same statement; scoped to a read-only transaction (or the caller's, restored). `pg-vector-recall.live.test.ts` forces the index on a large table where the tenant holds a small share |
| AI3 | deferred (OD8): documented only |
| M1 | shipped. One bounded page through the query's own `.page()`: 500 rows, 256 KiB, `truncated` + `nextCursor`, continued with `_after` (`query-page.ts`) |
| M2 | shipped. Concurrent stdio dispatch (≤ 16), `notifications/cancelled` → the call's signal, a cancelled call writes nothing. The concurrency review found the reader parked at the cap (a cancel or `ping` for a running call unread): now ≤ 64 requests queue while the reader reads on, `ping` never queues, a cancel removes a queued request |
| M3 | shipped. `stdio-lines.ts` counts bytes on the raw chunk |
| M4 | shipped. `missing-token` at `info`; `addressNetwork` on every `mcp.auth.*` line; the unauthenticated allowance keyed per IPv6 /64. Also: `mcpOAuthClient().begin` refuses non-URL metadata, resource metadata for another resource (RFC 9728 §3.3), and — the security review — an authorization or token endpoint that is not `https:` (loopback `http:` aside) |
| W1 | shipped. ≤ 50 documents per pages cache, oldest written first out; writes serialised so a trim never deletes a page a refresh just stored (the concurrency review). Ledger item fixed with it: a precached `/styles/<hash>.css` is served from the precache (`precached-asset-source.ts`), so an offline document is styled |
| bug hunt | `scraping/src/cdp-connection.ts`: a close answers every waiting `once()` false at once and clears its timer; `http/src/compress-precode.ts`: a synchronous coder throw is logged, never an unhandled rejection; `http/src/stages-log.test.ts`: the routine-refusal window reset per test (a full-run-only level leak) |

Ledger (later): admin/cli `McpTool` implementations take the optional signal; the MCP HTTP transport passes `request.signal`.
