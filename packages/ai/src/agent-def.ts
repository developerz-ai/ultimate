// Single responsibility: what an `agent()` DECLARATION is — its options, and the one event its
// observer is handed. Types only; ./agent owns the loop that reads them.

import type { ActionMcp, ActionPolicy } from '@ultimat3/action';
import type { Ctx } from '@ultimat3/core';
import type { Money } from '@ultimat3/money';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
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
}

export interface AgentVarsArgs<TInput extends StandardSchemaV1> {
  readonly input: InferOutput<TInput>;
  readonly ctx: Ctx;
}

export interface AgentDef<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
> {
  readonly model?: ModelId;
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
   * The actions the model may call. Each must be `mcp: { expose: true }` — the same predicate an
   * external MCP client is filtered by, so an in-app agent and an external one are offered
   * exactly the same tools. Listing one that is not exposed is refused at declaration rather than
   * dropped, because a tool that reads as offered and silently is not is the worst of both.
   */
  readonly tools: readonly AgentTool[];
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
  readonly policy: ActionPolicy;
  readonly mcp?: ActionMcp;
  /** Enforced completion ceiling PER TURN. The model never sees it. */
  readonly maxTokens?: number;
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
  /** This turn's cost alone, integer minor units — never the run's running total. */
  readonly cost: Money;
  /** The running total, this turn included — on the last turn, the whole run. */
  readonly run: AgentRunUsage;
}
