# 10 — ai, mcp, mail, notify, manifest

> Part of [`overview.md`](overview.md). Depends on: 01 (`hasPublicCause`), 07. Tier: 4. Path-disjoint from 09.
> `ai` / `notify` / `manifest` citations are the corrected ones in [`findings/sweep-3-verify-tier-4-5.md`](findings/sweep-3-verify-tier-4-5.md).

## Files to change
| Where | Change | Row |
|---|---|---|
| `packages/ai/src/tools.ts:206` (`describeFailure`) | a tool result carries `cause` / `fix` only when core's `hasPublicCause` says so | `s2-sec H1` |
| `packages/mcp/src/framework-error.ts:57`, `server.ts:458` | the same predicate on MCP error data | `s2-sec H1` |
| `packages/ai/src/hive.ts:134` | `currentBudget() ?? gateway.callLedger?.() ?? …` — the line `agent.ts:274-277` has | `s1-t4 #1`, `s2-sec M2` |
| `packages/ai/src/llm.ts:264`, `agent.ts:276`, `gateway.ts:119` | `actorKey` / `orgKey` derived from `ctx.actor`, as `actorScope()` (`llm-cache.ts`) | `s2-sec M1` |
| `packages/ai/src/budget.ts:169-205`, `gateway.ts:126` | reserve by debit-then-check, or key the turnstile on `(store, key)` | `s2-con #5` |
| `packages/ai/src/gateway.ts:381`, `:173-175` | the cache key includes each tool's `input_schema` and uses core's `fingerprint`; `cache.set` guarded | `s1-t4 #6`, `s1-arch #13`, `s2-con` low |
| `packages/ai/src/llm.ts:412-418`, `:364-366`, `wire.ts:130` | a non-object `output` is wrapped in `{ value }` and unwrapped, or refused at declaration | `s1-t4 #5` |
| `packages/ai/src/llm.ts:451` | `parseJsonish` linear on an unterminated fence | `s2-sec L6` |
| `packages/ai/src/rag.ts:51-83`, `:59`, `:186` | carried overlap dropped until the chunk fits; `source` written after the spread | `s1-t4 #7, #8` |
| `packages/ai/src/eval-baseline.ts:70,74,94,110` | both sides rounded | `s1-t4 #9` |
| `packages/ai/src/scorers.ts:93`, `openai-wire.ts:109`, `wire.ts:71`, `remote-embedder.ts:135,228`, `provider.ts:470-472` | exact match scores 1 at tolerance 0; one rule for an unknown finish reason; `withoutKey` scrub; clamped estimate | `s1-t4` lows, `s2-sec L5` |
| `packages/ai/src/vector-scope.ts:20` | an unscoped read inside a request context is refused; the backfill path opts in by name | `s1-sec L1` (narrowed: hardening) |
| `packages/mcp/src/readonly-sql.ts:147-165,192,216-228,343` | Unicode-escaped quoted identifiers refused; the XML query-execution family added; the word scan does not split on digits | `s1-t4 #17`, `s1-sec M4` |
| `packages/mcp/src/transport-http.ts:196-201` | an IP-keyed bucket before `resolveToken` | `s1-sec M5` |
| `packages/mcp/src/meta-surface.ts:302`, `list-params.ts:97-108` | `destructive === undefined` reads as `registry.ts:312` does; `listParamsSchema` admits whitelisted filters only | `s1-t4` low, gaps |
| `packages/mail/src/mail.ts:170-177` | `jobsFacade().enqueue(sendMailJob, message)` — stages on the caller's connection | `s1-con #3` |
| `packages/mail/src/job.ts:14,20-22` | recipients validated by the rule `envelopeAddress` applies | `s1-t4 #3` |
| `packages/mail/src/mime.ts:84`, `:135-141` | `List-Unsubscribe` normalised; a phrase with a comma quoted | `s1-t4 #10`, low |
| `packages/mail/src/driver-smtp.ts:87-88`, `mail.ts:93` | malformed credentials → a coded refusal; code-unit sort | `s1-t4` low |
| `packages/notify/src/fanout.ts:30-33,130`, `fanout-digest.ts:37,70,76` | audience deduped by `id` in the `open` step | `s1-t4 #2` |
| **new** `packages/notify/src/digest-pg.ts` | a Postgres digest store beside `createMemoryDigestStore` (`digest.ts:81`) | `s1-t4` gaps |
| `packages/manifest/src/sources.ts:122-131`, `README.md:22` | publish the query input schema, or delete `QueryFact.input` (`schema.ts:176`), the dead compare (`diff-operations.ts:120-121`) and the README claim | `s1-t4 #11` (narrowed) |
| `packages/manifest/src/build.ts:110`, `emit.ts:49`, `diff-entities.ts:85-114` | a non-finite fact refused at build; a dropped default reported | `s1-t4` low |

## Steps
1. Cause leak: one predicate, three renderers. The regression test asserts the same verdict `packages/http/src/problem-redaction.test.ts` pins — through `mcp` and through an `agent()` tool result — for `X_DB_STATEMENT_FAILED`. BREAKING for an agent that parses the database message: CHANGELOG.
2. Budgets: three separate holes (hive root, missing actor / org keys, per-scope turnstile). Order: hive root, then keys, then the reservation. `BudgetStore` (`spent` + `add`) cannot express an atomic reserve — adding `take(key, amount, limit)` changes a public seam: additive with a default built on the old two, so no major.
3. Mail in the transaction: `mail → jobs` is a downward import (tier 4 → 3). The `.job.` suite proves a rollback sends nothing. It is the one `driver.enqueue` site outside `jobs` — add it to the guard that holds "one enqueue implementation" if one exists (`grep -rn 'driver.enqueue\|jobDriver()' packages/*/src`), else slice 13 adds the check.
4. Digest store: a framework table (`x_notify_digests`) — DDL through the same path as the ledger and inbox stores; parity test against the memory store.
5. SQL guard: refuse, never decode. The file states the function ban is the only layer holding on PGlite.

## Tests
- `packages/ai/src/tools.test.ts`, `hive.test.ts`, `llm.test.ts`, `agent.test.ts`, `gateway-budget.test.ts`, `gateway.test.ts`, `rag.test.ts`, `eval-baseline.test.ts` (a `tolerance: 0` case), `provider-parity.test.ts`.
- `packages/mcp/src/server.test.ts`, `readonly-sql.test.ts`, `transport-http.test.ts`.
- `packages/mail/src/mail.test.ts`, `driver-parity.test.ts`, `mime.test.ts`; a `.job.` suite.
- `packages/notify/src/fanout.test.ts`, a digest parity test; `packages/manifest/src/sources.test.ts`.
- `bun test packages/ai packages/mcp packages/mail packages/notify packages/manifest`

## Owned elsewhere
- `packages/mcp/src/validate-args.ts:190` (regex flags), `packages/mail/src/mime.ts:84` `Reply-To` — 2026-09-28 plan, slice 05.
- `toMcpTool` vs `mcp`'s projection, the second validator (`s2-arch M3`) — slice 14.
- Refuted, not planned: `diff-routes` "gaining", `channel-mail` missing address (`s3-t45` §3).

## Done when
- An MCP client and a model see code + a fixed sentence for a hidden 5xx.
- A gateway `budget` holds for hive members, per actor, per org, under concurrency.
- `send()` inside a rolled-back transaction delivers nothing. A repeated recipient id does not fail the fan-out.
- `bun run manifest` regenerated if a manifest fact moved; `bun run verify` `manifest`, `contract-diff` green.
