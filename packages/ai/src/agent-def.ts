// Single responsibility: what an `agent()` DECLARATION is — its options, and the one event its
// observer is handed. Types only; ./agent owns the loop that reads them.

import type { ActionMcp, ActionPolicy } from '@ultimat3/action';
import type { Ctx } from '@ultimat3/core';
import type { Money } from '@ultimat3/money';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { AgentCompaction, AgentCompactOption } from './agent-compact-def';
import type { AgentSystem } from './agent-system';
import type { AgentRunUsage } from './agent-usage';
import type { LlmBudget } from './llm';
import type { ModelId } from './models';
import type { Prompt, PromptVars } from './prompt';
import type { PromptCacheOption } from './prompt-cache';
import type { StopReason, TokenUsage } from './provider';
import type { AgentTool } from './tools';

export interface AgentBudget extends LlmBudget {
  /**
   * Token ceiling for the WHOLE run, every turn counted. The one ceiling `llm()` does not need:
   * a single call is bounded by `maxTokens`, a loop is bounded by nothing until this is set.
   */
  readonly tokensPerRun?: number;
  /**
   * Money ceiling for the WHOLE run, every turn and every continuation counted, integer minor
   * units. Checked before each turn against what the run has cost so far plus that turn's
   * worst-case estimate — the run-level twin of `costPerCall`. A refusal is `X_AI_BUDGET_EXCEEDED`
   * (scope `costPerRun`) before the provider is called.
   */
  readonly costPerRun?: Money;
}

/**
 * The ceilings ONE run may lower (`limits()`), under the keys the declaration uses. Each may only
 * be at or under the declared value (after its default); a higher one is `X_AI_REQUEST_INVALID`.
 * One the declaration leaves unset (`deadlineMs`, a `budget` key) may be set by a run: any value
 * is tighter than none.
 */
export interface AgentRunLimits {
  readonly maxTurns?: number;
  readonly maxTokens?: number;
  readonly maxToolResultChars?: number;
  readonly maxRepeatedToolCalls?: number;
  readonly deadlineMs?: number;
  readonly budget?: AgentBudget;
}

/**
 * The model a run is on: an id, or a function of the run's input and context answering one —
 * `undefined` from it falls through to the prompt's `model`, then the gateway's `defaultModel`.
 */
export type AgentModel<TInput extends StandardSchemaV1> =
  | ModelId
  | ((args: AgentVarsArgs<TInput>) => ModelId | undefined | Promise<ModelId | undefined>);

export interface AgentVarsArgs<TInput extends StandardSchemaV1> {
  readonly input: InferOutput<TInput>;
  readonly ctx: Ctx;
}

export interface AgentDef<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
> {
  /**
   * An id, or a function picking one per run (a stored override, a tier for this tenant). Either
   * way it is resolved through the model registry — an unregistered id is `X_AI_MODEL_UNKNOWN`
   * before anything is loaded — and bound into the transcript handle, so `.continue()` runs on the
   * model the run started on or is refused.
   */
  readonly model?: AgentModel<TInput>;
  readonly input: TInput;
  readonly output: TOutput;
  readonly prompt: Prompt<V>;
  /** Same contract as `llm()`: the one declared place a run loads data. */
  vars(args: AgentVarsArgs<TInput>): V | Promise<V>;
  /**
   * System text loaded at RUN time, beside the prompt's static `system`: a knowledge-base index,
   * today's date. Redacted like the prompt. Not part of the prompt's hash, exactly as `vars` is not.
   */
  system?(args: AgentVarsArgs<TInput>): AgentSystem | Promise<AgentSystem>;
  /**
   * Provider prompt caching. Default `'auto'`: every turn's request asks the provider to cache its
   * prefix (the stable system block, then the transcript up to its tail), so turn N+1 reads turn
   * N's prefix at the cache rate instead of paying input for it again. `'off'` sends no mark.
   * `{ session }` is `'auto'` plus a key for hosts that route by one. `PROMPT_CACHE_RULES` decides
   * what each wire is sent; a host that caches implicitly is sent nothing either way.
   */
  readonly promptCache?: PromptCacheOption<AgentVarsArgs<TInput>>;
  /**
   * Auto-compaction. Default `'auto'`: before a turn whose request the gateway estimates over
   * `at` (0.8) of the model's `contextWindow` less `maxTokens`, ONE model call summarises the turns
   * older than the last `keepTurns` (4) into the first user message; the system prompt, the tools
   * and the kept turns are sent byte for byte as before. A request that still would not fit is
   * `X_AGENT_CONTEXT_EXHAUSTED` before it is sent. `'off'` never compacts and never checks.
   */
  readonly compact?: AgentCompactOption;
  /**
   * What the model may call: an `action()` that is `mcp: { expose: true }` — the same predicate an
   * external MCP client is filtered by, so both are offered the same actions — or an
   * `inProcessTool()`, which only this process's agents ever see. Anything else is refused at
   * declaration rather than dropped: a tool that reads as offered and silently is not is the worst
   * of both.
   */
  readonly tools: readonly AgentTool[];
  /**
   * The tool NAMES this run is offered — a subset of `tools`, picked per run (a stored permission
   * rule, the actor's plan). Unset offers every declared tool. A name the declaration does not
   * list is `X_AGENT_TOOL_UNDECLARED` before anything is loaded: a run narrows the catalogue and
   * never adds to it. The model sees only the subset, a call to any other tool answers
   * `unknown tool`, and the transcript handle is bound to the subset offered.
   */
  offerTools?(args: AgentVarsArgs<TInput>): readonly string[] | Promise<readonly string[]>;
  /**
   * `false` withholds the refusals of EVERY in-process tool this agent runs, as a projected tool's
   * are — for an agent whose transcript leaves the tenant it ran for. Default `true`; one tool
   * opts out with `inProcessTool({ discloseErrors: false })`.
   */
  readonly discloseToolErrors?: boolean;
  /** Hard ceiling on model turns. Reaching it is `X_AGENT_MAX_TURNS`, never a partial answer. */
  readonly maxTurns?: number;
  readonly maxToolResultChars?: number;
  /**
   * Consecutive turns that may make the SAME tool calls and read the SAME results. Reaching it is
   * `X_AGENT_TOOL_LOOP`. Default 3.
   */
  readonly maxRepeatedToolCalls?: number;
  /**
   * Wall-clock ceiling for the whole run, in milliseconds. Passing it aborts the model call in
   * flight and is `X_AGENT_DEADLINE`. No default: a timeout nobody declared is a lost answer.
   */
  readonly deadlineMs?: number;
  readonly budget?: AgentBudget;
  /**
   * Ceilings for ONE run, read from its input and context (a stored override, a cheaper tier):
   * each may only LOWER the declared one — see `AgentRunLimits`. Called once per `.run()`,
   * `.continue()` or plain call, before the deadline is armed and before `vars()`.
   */
  limits?(args: AgentVarsArgs<TInput>): AgentRunLimits | Promise<AgentRunLimits>;
  readonly policy: ActionPolicy;
  readonly mcp?: ActionMcp;
  /** Enforced completion ceiling PER TURN. The model never sees it. */
  readonly maxTokens?: number;
  /**
   * `temperature` (0 to 2) and `seed` (a whole number), for a call that should answer the same way
   * twice — a verifier, a classifier. Sent only to a model whose row takes them
   * (`registerModel({ sampling })`); to any other they are NOT sent, because a reasoning model
   * answers one with a 400 — the `llm.sampling.ignored` span attribute names what was left out.
   * `seed` exists on the chat-completions wire only, and is best effort where it exists.
   */
  readonly temperature?: number;
  readonly seed?: number;
  /**
   * Called once per completed model turn, before the answer or the tool calls are acted on. The
   * one thing a multi-turn run could not do until 2026-08: a 90-second loop emitted nothing until
   * it returned, so a progress indicator, a per-turn spend line and a transcript log all had to be
   * hand-rolled outside the framework — which is exactly the loop `agent()` exists to replace.
   *
   * Observation only: it cannot steer the loop, cannot see the transcript and cannot reach the
   * actor. A throw from it FAILS the run rather than being swallowed — it is the app's code on the
   * run's own path, and an observer that silently stopped working would be indistinguishable from
   * one that is fine. The same facts land on the span as an `agent.turn` event, so a run that
   * declares no hook is still readable in a trace.
   *
   * NOT `.stream()`. Tokens on a screen is a different contract, and `llm()`'s streamed half is
   * one turn deep by construction; this is per TURN.
   */
  onTurn?(event: AgentTurn): void | Promise<void>;
  /**
   * Called once per compaction ATTEMPT, before the turn it was for is sent — `outcome:
   * 'compacted'` or `'failed'` with the reason. Same contract as `onTurn`: observation only, and a
   * throw fails the run. Also an `agent.compact` span event.
   */
  onCompact?(event: AgentCompaction): void | Promise<void>;
}

/** One completed model turn, as an observer sees it. Facts only — no transcript, no actor. */
export interface AgentTurn {
  /** 1-based, so `turn === maxTurns` is the last one this run will take. */
  readonly turn: number;
  readonly maxTurns: number;
  readonly model: ModelId;
  /** Tools this turn asked for, in the order the model emitted them. `respond` is not one. */
  readonly toolCalls: readonly string[];
  readonly stopReason: StopReason;
  readonly usage: TokenUsage;
  /** This turn's cost alone, integer minor units, rounded up — never the run's running total. */
  readonly cost: Money;
  /** This turn's cost exactly (`Money` at a finer `scale`); absent when the provider stated none. */
  readonly costExact?: Money;
  /**
   * Set on a REPAIR turn: the schema issues of the previous turn's answer, which is what the
   * model was told to fix before it produced this one. Absent on every other turn.
   */
  readonly repairOf?: readonly string[];
  /** The running total, this turn included — on the last turn, the whole run. */
  readonly run: AgentRunUsage;
}
