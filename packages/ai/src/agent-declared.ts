// Single responsibility: what an `agent()` declaration AMOUNTS to before a run exists — its
// defaults, the screen its bounds pass at declaration, the budget limits one call runs under, and
// the row `describeAgents()` publishes. Split from ./agent at its line ceiling.

import { finiteCount, isMcpExposed } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { AgentBudget, AgentDef } from './agent-def';
import type { AgentFact } from './agent-facts';
import { DEFAULT_MAX_REPEATED_TOOL_CALLS } from './agent-guards';
import type { BudgetLimits } from './budget';
import { screenedMoney } from './budget';
import { AiBudgetExceededError, AiRequestInvalidError } from './errors';
import { describedModel, type ModelSource } from './model-resolve';
import type { PromptVars } from './prompt';
import type { TokenUsage } from './provider';
import { totalTokens } from './provider';
import { installedGateway } from './runtime';
import { toolLabel } from './tools';

/**
 * Turn ceiling when the declaration omits one. Low on purpose: a loop that needs more than this
 * is usually a loop with no exit condition, and every turn re-sends the whole transcript, so cost
 * grows quadratically in turns rather than linearly.
 */
export const DEFAULT_MAX_TURNS = 8;

/** Output ceiling per turn when the declaration omits one. Same reasoning as `llm()`'s. */
export const DEFAULT_MAX_TOKENS = 4_096;

/**
 * Characters of ONE tool result the model may read. A tool that returns a 2MB row set otherwise
 * spends the whole context window on turn two and every later turn re-sends it — the transcript
 * is the request, so an untruncated result is billed once per remaining turn.
 */
export const DEFAULT_TOOL_RESULT_CHARS = 4_000;

/** Named in every bound refusal, so the fix names the key the declaration carries. */
export const SUBJECT = 'agent';

/** The loop's bounds with their defaults applied — read by the run from HERE, never re-defaulted. */
export interface AgentBounds {
  readonly maxTurns: number;
  readonly maxToolResultChars: number;
  readonly maxTokens: number;
  readonly maxRepeatedToolCalls: number;
}

/** The loop bounds, screened at DECLARATION: `agent()` runs at module scope, so a bad one fails the boot. */
export function screenBounds<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(def: AgentDef<TInput, TOutput, V>): AgentBounds {
  // The three loop bounds, screened at DECLARATION for the same reason the tool check above is:
  // the values are here, and an `agent()` runs at module scope, so a bound that is not one fails
  // the boot instead of the ninetieth second of a run. None of them is checked by what it lands
  // on — `turn <= NaN` is false on the FIRST comparison, so the loop takes zero turns and reports
  // `X_AGENT_MAX_TURNS` about a model that was never called; `slice(0, NaN)` is `''`, so every
  // tool result reaches the model empty while the run keeps paying for turns; and `maxTokens`
  // becomes the pre-flight estimate, where a `NaN` disables the ledger for the whole process.
  const maxTurns = finiteCount(SUBJECT, 'maxTurns', def.maxTurns ?? DEFAULT_MAX_TURNS, 1);
  const maxToolResultChars = finiteCount(
    SUBJECT,
    'maxToolResultChars',
    def.maxToolResultChars ?? DEFAULT_TOOL_RESULT_CHARS,
    1,
  );
  const maxTokens = finiteCount(SUBJECT, 'maxTokens', def.maxTokens ?? DEFAULT_MAX_TOKENS, 1);
  const repeats = finiteCount(
    SUBJECT,
    'maxRepeatedToolCalls',
    def.maxRepeatedToolCalls ?? DEFAULT_MAX_REPEATED_TOOL_CALLS,
    1,
  );
  if (repeats < 2) {
    // One "repeat" is the first tool turn of every run: the agent could never use a tool.
    throw new AiRequestInvalidError({
      detail: `agent maxRepeatedToolCalls is ${repeats}, which would stop every run at its first tool turn`,
      fix: 'maxRepeatedToolCalls: 3   # on the agent — at least 2; it counts consecutive identical turns, the first included',
    });
  }
  // `AbortSignal.timeout(NaN)` throws a RangeError mid-run; `0` aborts before turn one.
  if (def.deadlineMs !== undefined) finiteCount(SUBJECT, 'deadlineMs', def.deadlineMs, 1);
  return { maxTurns, maxToolResultChars, maxTokens, maxRepeatedToolCalls: repeats };
}

// `null`, not `undefined`, for a row naming no model yet: the row is a published fact, and an
// absent key reads as a reader that forgot to ask.
const modelFact = (described: {
  readonly model: string | undefined;
  readonly from: ModelSource | undefined;
}): Pick<AgentFact, 'model' | 'modelFrom'> => ({
  model: described.model ?? null,
  modelFrom: described.from ?? null,
});

export function factsOf<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(def: AgentDef<TInput, TOutput, V>): Omit<AgentFact, 'name'> {
  const budget = def.budget;
  return {
    prompt: def.prompt.ref,
    promptId: def.prompt.id,
    promptHash: def.prompt.hash,
    // The run's own precedence, so the row names the model a call would use NOW: read when the
    // facts are, at describe time, like every name in the row. `modelFrom` says which place
    // answered — `gateway` (or `null`, none yet) depends on the gateway installed at that moment.
    // A model picked per run (`model` as a function) has no answer until a run asks it.
    ...(typeof def.model === 'function'
      ? { model: null, modelFrom: 'run' as const }
      : modelFact(describedModel(def.model, def.prompt.model, installedGateway()?.defaultModel))),
    maxTurns: def.maxTurns ?? DEFAULT_MAX_TURNS,
    maxToolResultChars: def.maxToolResultChars ?? DEFAULT_TOOL_RESULT_CHARS,
    tools: [...def.tools.map(toolLabel)].sort(),
    budget: {
      tokensIn: budget?.tokensIn ?? null,
      tokensPerRun: budget?.tokensPerRun ?? null,
      costPerCall: budget?.costPerCall ?? null,
      costPerRun: budget?.costPerRun ?? null,
    },
    mcp: isMcpExposed(def.mcp),
  };
}

export function limitsOf(budget: AgentBudget | undefined, used?: TokenUsage): BudgetLimits {
  // `costPerRun` is not a ledger scope — the run checks it before each turn (`assertRunCost`) —
  // but it is screened here with the rest, so a bad one is refused before anything is loaded.
  if (budget?.costPerRun !== undefined) {
    screenedMoney(SUBJECT, 'budget.costPerRun', budget.costPerRun);
  }
  return {
    // Screened under the names the DECLARATION uses, not the ledger's: `tokensPerRun` arrives at
    // `BudgetLimits` as `request`, and a fix line naming a key the app never wrote is not a fix.
    ...(budget?.tokensIn === undefined
      ? {}
      : { tokensIn: finiteCount(SUBJECT, 'budget.tokensIn', budget.tokensIn) }),
    ...(budget?.costPerCall === undefined
      ? {}
      : { costPerCall: screenedMoney(SUBJECT, 'budget.costPerCall', budget.costPerCall) }),
    // The ledger's `request` scope accumulates across every call made under one ledger, which for
    // a run under `withBudget` is exactly "the whole run".
    ...(budget?.tokensPerRun === undefined
      ? {}
      : {
          request: leftOf(finiteCount(SUBJECT, 'budget.tokensPerRun', budget.tokensPerRun), used),
        }),
  };
}

/**
 * `tokensPerRun` for THIS call: the declared ceiling less what the run's earlier calls used. Never
 * a debit on the ledger — that would bill the actor and org scopes a second time for tokens they
 * were already charged — so the remainder is the ceiling, and none left is refused before a call.
 */
function leftOf(limit: number, used: TokenUsage | undefined): number {
  const spent = used === undefined ? 0 : totalTokens(used);
  if (spent < limit) return limit - spent;
  throw new AiBudgetExceededError({ scope: 'request', requested: 1, remaining: 0, limit });
}
