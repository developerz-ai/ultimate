# 18 — `scriptedProvider` and `meteredRun`

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 4 (`ai`).

## Why
**Scripted turns.** `echoProvider` (`packages/ai/src/echo-provider.ts`) cannot emit a tool call. Two adopters hand-rolled it (203 and 138 LOC), and this repo has its own in several fixtures (`agent-per-run-fixture.ts:42`, `agent-continue-fixture.ts:38`, `llm-fixture.ts:37`). Same shape each time.
**Run totals.** Two adopters built per-run meters (112 and 158 LOC). `llm()` does report usage: `onCall` (`packages/ai/src/llm-def.ts:77`; `call-observability.test.ts` passes) and `onTurn` carry `run`, and the claim that it reports none is false. What does not exist is one total across several `llm()` and `agent()` calls in one job. `runMeter` already rolls nested calls up to a parent (`packages/ai/src/run-meter.ts:98`) and is unexported.

## Files to change
- `packages/ai/src/scripted-provider.ts` (new), `packages/ai/src/run-meter.ts`, `packages/ai/src/errors.ts`, `packages/ai/src/index.ts:86`.
- `packages/ai/src/agent-per-run-fixture.ts`, `agent-continue-fixture.ts`, `llm-fixture.ts` — drop hand-rolled providers for `scriptedProvider`.
- `packages/ai/README.md`, `packages/ai/CLAUDE.md`, `wiki/Agents.md`, `wiki/Testing.md`.
- `examples/dummy/apps/web/app/posts/actions/review-draft.ts` — its test uses `scriptedProvider`.

## Steps
1. `scriptedProvider({ turns, usage? })`: each turn is `{ text }`, `{ call, input? }`, `{ calls: [...] }` or `{ answer }` (a `respond` call). Serves every registered model through the getter `EchoProvider` uses. Exposes `.seen`. Running out of turns raises `X_AI_SCRIPT_EXHAUSTED`, never repeats the last: a loop must not look like a pass. Fixtures that rely on repeating spell their turns out.
2. `meteredRun(fn): Promise<{ value, billed }>` over `runMeter().within(fn)`. On a throw it calls `meter.fail`, so `billedOf(error)` reads the total. `RunMeter` stays internal; `Billed` already ships. No ledger or budget behaviour.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_AI_SCRIPT_EXHAUSTED` (new, off-socket) | more provider calls than turns | `add a turn to scriptedProvider({ turns }), or fix the loop calling it, then bun test`. `bun run new-error-code X_AI_SCRIPT_EXHAUSTED --package ai --title '…' --cause '…' --fix '…' --off-socket` |

## Tests
- `packages/ai/src/scripted-provider.test.ts` (unit): each turn form through a real `agent()`; exhaustion raises the code.
- `packages/ai/src/run-meter.test.ts` (unit): two `llm()` calls and one nested `agent()` sum once; a failing call still carries the total; nothing started gives `billed: undefined`.
- `bun test packages/ai/src/scripted-provider.test.ts`

## Semver
Minor. New exports. No Upgrading entry.

## Done when
- The three fixtures hold no hand-rolled provider.
- `meteredRun` over two `llm()` calls reports both.
- `bun run verify` green; `bun run scripts/reference-app-gate.ts` green.
