// Single responsibility: a run's running token and money total, across its turns and its
// continuations.

import type { Money } from '@ultimat3/money';
import type { Billed } from './billed';
import { addMoney, costOf, exactCostOf, roundUpCost } from './cost';
import type { ModelId } from './models';
import type { GenerateResult, TokenUsage } from './provider';

/** The run so far, this turn included. */
export interface AgentRunUsage {
  readonly usage: TokenUsage;
  /** In the currency's minor units, rounded up ONCE over the whole run — never a sum of turns. */
  readonly cost: Money;
  /** The same figure exactly, as `Money` at a finer `scale` (`exactCostOf`). */
  readonly costExact: Money;
}

const ZERO: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const plus = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

/** `usage` on `model`, priced once: each turn's own cost is rounded up, and ten round-ups is not the price of the run. */
const priced = (model: ModelId, usage: TokenUsage): AgentRunUsage => ({
  usage,
  cost: costOf(model, usage),
  costExact: exactCostOf(model, usage),
});

/** The run's total after one more turn, re-priced from the summed usage. */
export function addUsage(total: AgentRunUsage | undefined, result: GenerateResult): AgentRunUsage {
  return priced(result.model, plus(total?.usage ?? ZERO, result.usage));
}

/**
 * A run's total across its continuations: what the handle already held plus what this call used,
 * priced once from the sum.
 */
export function runTotal(
  model: ModelId,
  prior: TokenUsage | undefined,
  own: { readonly usage: TokenUsage } | undefined,
  /** What runs underneath were billed (`RunMeter.below`): another model's price, so ADDED, never re-priced. */
  below?: Billed,
): AgentRunUsage {
  const base = priced(model, plus(prior ?? ZERO, own?.usage ?? ZERO));
  if (below === undefined || below.cost.currency !== base.cost.currency) return base;
  return {
    usage: plus(base.usage, below.usage),
    cost: addMoney(base.cost, roundUpCost(below.cost)),
    costExact: addMoney(base.costExact, below.cost),
  };
}
