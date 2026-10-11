// Single responsibility: a run's running token and money total, across its turns.

import type { Money } from '@ultimat3/money';
import type { ModelId } from './models';
import type { GenerateResult, TokenUsage } from './provider';
import { costOf } from './provider';

/** The run so far, this turn included. */
export interface AgentRunUsage {
  readonly usage: TokenUsage;
  readonly cost: Money;
}

/**
 * The run's total after one more turn. The cost is re-priced from the summed usage rather than
 * summed per turn: each turn's cost is rounded UP to a minor unit, and ten round-ups is not the
 * price of the run.
 */
export function addUsage(total: AgentRunUsage | undefined, result: GenerateResult): AgentRunUsage {
  const before = total?.usage;
  const usage: TokenUsage = {
    inputTokens: (before?.inputTokens ?? 0) + result.usage.inputTokens,
    outputTokens: (before?.outputTokens ?? 0) + result.usage.outputTokens,
    cacheReadTokens: (before?.cacheReadTokens ?? 0) + result.usage.cacheReadTokens,
    cacheWriteTokens: (before?.cacheWriteTokens ?? 0) + result.usage.cacheWriteTokens,
  };
  return { usage, cost: costOf(result.model, usage) };
}

/**
 * A run's total across its continuations: what the handle already held plus what this call used,
 * priced once from the sum.
 */
export function runTotal(
  model: ModelId,
  prior: TokenUsage | undefined,
  own: AgentRunUsage | undefined,
): AgentRunUsage {
  const a = prior ?? ZERO;
  const b = own?.usage ?? ZERO;
  const usage: TokenUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
  return { usage, cost: costOf(model, usage) };
}

const ZERO: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
