# 27 — `onCheckpoint`: an agent run survives a dead worker

> Part of [`overview.md`](overview.md). Depends on: [`18-ai-scripted-and-meter.md`](18-ai-scripted-and-meter.md). Tier: 4 (`ai`).

## Why
A worker that dies mid-run throws nothing, so `transcriptOf(error)` has nothing to carry. The next attempt starts from the top: every turn re-billed, every tool re-run (`wiki/Agents.md:714`). `onTurn` fires **before** the tool batch (`packages/ai/src/agent.ts:326`) and carries no transcript by rule, so an app cannot save progress. A handle exists only once a run returned or threw.

Two adopters built this beside the framework: 310 LOC (store, resume, settle) and 776 LOC (per-step checkpoint, continuation, liveness). One lists it as an open gap against `agent()`. Most of the resume half exists: a mid-run handle is the shape `transcriptOf(error)` already seals (`agent.ts`, `at.messages`), and `continued()` already merges into a trailing user message (`packages/ai/src/agent-continue.ts:195`).

Measured: `sealTranscript` over 1.9M characters averages 10.6 ms. It is paid only when the hook is declared.

## Files to change
- `packages/ai/src/agent-def.ts:169` — `onCheckpoint?(event: AgentCheckpoint): void | Promise<void>`.
- `packages/ai/src/agent.ts:385` — after a tool turn or a repair turn lands in `messages`, seal and await the hook.
- `packages/ai/src/agent-continue.ts` — export the event type; no change to the screen.
- `packages/ai/src/index.ts`, `packages/ai/README.md`, `packages/ai/CLAUDE.md`, `docs/history/ai.md`, `wiki/Agents.md:490,708-726`.
- `examples/dummy/apps/web/app/posts/actions/keep-draft-review.ts` — stores the handle on the review row and resumes from it; the migration and both schema dumps with it (`bun run schema-dumps`).

## Steps
1. `AgentCheckpoint = { turn, transcript: AgentTranscript, run: AgentRunUsage }`. Same signature and bindings as any handle, so a tampered or cross-tenant copy is refused by the existing screen.
2. Called after the results of turn N are appended and before turn N+1 is bought. Awaited. A throw fails the run, as `onTurn`'s does (`wiki/Agents.md:609`): a checkpoint that silently stopped reads like one that works.
3. Not called after the final answer: `.run()` returns that handle.
4. Plain calls too: the hook reads no session (`agent.ts`, `session.finished` stays `.run()`'s).
5. Resume is the existing call, nothing new: `agent.continue(input, { transcript: stored, user })`. `maxTurns`, `tokensPerRun` and `costPerRun` count from the handle; `deadlineMs` is per call.
6. Document the recipe for a wrapping action under `agentJob`: load the stored handle, `.continue` if present, else `.run`. Catch `X_AGENT_TRANSCRIPT_INVALID` and start fresh: a deploy that bumps the prompt or changes the model invalidates a stored handle by design, and a retried attempt must not dead-letter on it.
7. State the limit. A worker dying **during** a tool batch re-asks the model for that turn, so those tools may run again. The at-least-once rule in `wiki/Agents.md:710` still binds. The replay shrinks from the whole run to one turn. No store of open tool calls: the screen refuses an unanswered `tool_use` by design (`docs/history/ai.md:766`), and no parked state is added.
8. No `agentJob({ checkpoint })` option. Where a handle lives is the app's row, stored as tool results may be (`wiki/Agents.md:490`).
9. `onCompact`'s rewrite is covered: the next checkpoint holds the compacted messages and the signed `compacted` count.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_AGENT_TRANSCRIPT_INVALID` (existing) | a stored checkpoint outlived a prompt bump, a model change or a secret rotation | existing fix: start a new `.run()` |

## Tests
- `packages/ai/src/agent-checkpoint.test.ts` (unit, `scriptedProvider`): three tool turns; hook seen twice with growing `turn`; abandon the run after the second; `.continue` from the stored handle. Asserts each earlier tool ran once, provider calls total the remainder, `usage` sums both, and `maxTurns` counts across.
- Same file: a throwing hook fails the run; no hook means no seal (spy); an edited handle is refused; a repair turn checkpoints.
- `examples/dummy/apps/web/app/posts/review.job.test.ts` (job): an attempt killed after its first checkpoint; the retry takes fewer model calls than a full run, on the production worker.
- `bun test packages/ai/src/agent-checkpoint.test.ts`

## Semver
Minor. New optional hook; a run without it is byte-identical.

## Done when
- The job test shows the retry resuming: fewer model calls, the first tool not re-run.
- `bun run verify` green; `bun run scripts/reference-app-gate.ts` green.
