// Single responsibility: what an `llm()` DECLARATION is — its options, and the one event its
// observer is handed. Types only; ./llm owns the call that reads them. `agent-def.ts`'s twin.

import type { ActionMcp, ActionPolicy } from '@ultimat3/action';
import type { Ctx } from '@ultimat3/core';
import type { Money } from '@ultimat3/money';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { AgentRunUsage } from './agent-usage';
import type { LlmCache } from './llm-cache';
import type { ModelId } from './models';
import type { Prompt, PromptVars } from './prompt';
import type { PromptCacheOption } from './prompt-cache';
import type { StopReason, TokenUsage } from './provider';

/** Per-call ceilings, checked before the provider is reached. Never truncates — refuses. */
export interface LlmBudget {
  /** Prompt tokens. */
  readonly tokensIn?: number;
  /** Worst-case price of one call, integer minor units. */
  readonly costPerCall?: Money;
}

export interface LlmVarsArgs<TInput extends StandardSchemaV1> {
  readonly input: InferOutput<TInput>;
  readonly ctx: Ctx;
}

export interface LlmDef<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
> {
  /**
   * Overrides the prompt artifact's own model. The prompt's is part of its content hash and
   * travels with it; this one is the deployment decision, so it wins.
   */
  readonly model?: ModelId;
  readonly input: TInput;
  readonly output: TOutput;
  readonly prompt: Prompt<V>;
  /**
   * Everything the prompt is allowed to see, derived from the parsed input. Required, and
   * async, because the input is usually an id and the prompt needs the row behind it — this
   * is the one declared place a model call loads data, so a reader can see what was sent.
   */
  vars(args: LlmVarsArgs<TInput>): V | Promise<V>;
  readonly cache?: LlmCache<InferOutput<TInput>>;
  /**
   * PROVIDER prompt caching (`./prompt-cache`) — not `cache`, which is this package's own semantic
   * cache. Default `'off'`: a one-shot call marked for caching pays the write premium (1.25x on
   * Anthropic) for a prefix nothing may ever read back. `'auto'` is for a call made many times
   * inside the cache's lifetime with one long `system`; the repair turn reads it back either way.
   */
  readonly promptCache?: PromptCacheOption<LlmVarsArgs<TInput>>;
  readonly budget?: LlmBudget;
  readonly policy: ActionPolicy;
  readonly mcp?: ActionMcp;
  /** Enforced completion ceiling. The model never sees it, so it can be cut off mid-answer. */
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
   * Called once per PROVIDER call this invocation makes — the answer, and the repair turn when
   * there is one — before the answer is read. What `agent()`'s `onTurn` is to a run: the usage and
   * cost of each call, and on a repair call the issues the model was told to fix.
   *
   * Observation only. Awaited, and a throw from it FAILS the call, for the reason `onTurn` gives.
   * Not called on a semantic-cache hit: no provider call was made, and nothing was billed.
   */
  onCall?(event: LlmCall): void | Promise<void>;
}

/** One completed provider call of an `llm()` invocation, as an observer sees it. Facts only. */
export interface LlmCall {
  /** 1 is the answer; 2 is the repair turn. A streamed call is always 1. */
  readonly attempt: number;
  readonly model: ModelId;
  /** Which provider answered, as the gateway stamped it. */
  readonly provider: string | undefined;
  readonly stopReason: StopReason;
  readonly usage: TokenUsage;
  /** This call's cost alone, integer minor units, rounded up. */
  readonly cost: Money;
  /** This call's cost exactly (`Money` at a finer `scale`); absent when the provider stated none. */
  readonly costExact?: Money;
  /** On the repair turn: the schema issues of the first answer — what the model was told to fix. */
  readonly repairOf?: readonly string[];
  /** The invocation so far, this call included — priced once from the summed usage. */
  readonly run: AgentRunUsage;
}
