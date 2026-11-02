# 27 — Compaction reads what the provider reported; a real overflow recovers

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 4 (`ai`).

## Why
**The estimate ignores the measurement.** `fit` decides on four characters a token (`packages/ai/src/agent-compact.ts:108`, `promptTokens`), and each turn's `usage` reports the true count. Probe: window 3,000, `at` 0.8, so the trigger is 2,000; tool results in a script at about 1.3 characters a token:
```
call 5 est4=670 real=2061     no compaction
call 6 est4=810 real=2491     no compaction
call 7 est4=950 real=2921     THROW X_AI_PROVIDER_UNAVAILABLE (prompt is too long)
```
Provider reported 2,061 at call 5; `onCompact` never fired. The promise "before the call, never after a 400" (`docs/history/ai.md:771`) fails exactly for non-Latin text and dense JSON.

**The overflow reads as an outage.** That failure is `X_AI_PROVIDER_UNAVAILABLE`, the transport code. A job retries it and buys every turn again. `X_AGENT_CONTEXT_EXHAUSTED` is the `terminal` code for this event and is never reached. One adopter pattern-matches provider text to compact and retry once. The history's "after a 400 there is no request left to fix" is false: the loop still holds the transcript.

## Files to change
- `packages/ai/src/agent-compact.ts:60-70,108` — `fit` scales by the reported ratio; `observe(usage, request)` and `force(messages, turn)` on `Compactor`.
- `packages/ai/src/agent.ts` — `observe` after each `generate`; catch the overflow once per turn.
- `packages/ai/src/error-body.ts`, `packages/ai/src/provider.ts`, `packages/ai/src/openai-provider.ts` — a 400/413 whose body says the prompt outgrew the window raises `AiContextOverflowError`.
- `packages/ai/src/errors.ts`, `errors-retry.ts` — the code, registered `terminal`.
- `packages/ai/README.md`, `packages/ai/CLAUDE.md`, `docs/history/ai.md:771-811`, `wiki/Agents.md:496-524`, `wiki/Error-Codes.md`, `wiki/Upgrading.md`.

## Steps
1. `observe`: after a turn, `ratio = max(1, (inputTokens + cacheReadTokens + cacheWriteTokens) / promptTokens(request))`. `fit` compares `ceil(promptTokens × ratio)` against the trigger. A provider reporting zero leaves it 1, so behaviour matches today. Below 1 is ignored: the estimate may stay pessimistic.
2. Ratio is per run and not signed into the handle: a continuation's first turn estimates plainly, and its second has a measurement. `before` and `after` in `AgentCompaction` report the scaled figure.
3. Overflow detection in one predicate, one table of provider phrases, tested per wire. The gateway already rethrows a coded refusal verbatim (`packages/ai/src/gateway.ts:348`), so it stops there, with no retry and no second provider.
4. The loop catches `X_AI_CONTEXT_OVERFLOW` once per turn: `force` compacts regardless of the trigger, then re-sends. A second overflow, or `compact: 'off'`, ends as `X_AGENT_CONTEXT_EXHAUSTED` with the provider's text as `reason`. The refused call billed nothing; count it in `unsettled` only if the wire reports otherwise.
5. `llm()` and a direct `generate()` raise `X_AI_CONTEXT_OVERFLOW` as themselves, with no retry.
6. Unreported cache counts stay `0`. `cacheReadTokens?: number` breaks every reader of `TokenUsage` for one adopter's hit-rate display, which it already solved.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_AI_CONTEXT_OVERFLOW` (new) | a provider refused the request as over the window | `compact: { at: 0.6, keepTurns: 2 }` on the agent, or a shorter prompt, or a model with a larger `contextWindow`. `bun run new-error-code X_AI_CONTEXT_OVERFLOW --package ai --title '…' --cause '…' --fix '…' --status 500` |
| `X_AGENT_CONTEXT_EXHAUSTED` (existing) | now also after a failed recovery | existing fix |

## Tests
- `packages/ai/src/agent-compact-measured.test.ts` (unit): the probe above; `onCompact` fires by call 6 and the run answers. A provider reporting zero compacts where today's does; requests byte-identical below the trigger.
- `packages/ai/src/agent-compact-overflow.test.ts` (unit): a provider that overflows once recovers and bills one summary; twice is `X_AGENT_CONTEXT_EXHAUSTED`, `terminal`; `compact: 'off'` makes no second call.
- `packages/ai/src/provider-parity.test.ts`: the same overflow body on both wires gives the same code, with no retry; a 400 about something else stays what it was.
- `bun test packages/ai/src/agent-compact-measured.test.ts`

## Semver
Breaking in behaviour, narrowly. `wiki/Upgrading.md`: "a prompt over the model's window was `X_AI_PROVIDER_UNAVAILABLE`; it is now `X_AI_CONTEXT_OVERFLOW`, `terminal` for a job, and `agent()` compacts and retries first. Code that matched the provider's text can drop it. Long runs on dense or non-Latin tool results compact earlier than before."

## Done when
- The probe's run answers instead of throwing.
- An `agentJob` overflow that cannot recover dead-letters on attempt 1.
- `bun run verify` green; `bun run scripts/reference-app-gate.ts` green.
