// Single responsibility: the ceilings ONE agent run runs under — the declared bounds narrowed by
// that run's own `limits()`, never widened — and the run-level money ceiling (`costPerRun`),
// checked before each turn. Split from ./agent-declared, which owns the declaration's half.

import { finiteCount } from '@ultimat3/core';
import type { Money } from '@ultimat3/money';
import { assertSameCurrency, commonScale, exponentOf, minorAt } from '@ultimat3/money';
import type { AgentBounds } from './agent-declared';
import { SUBJECT } from './agent-declared';
import type { AgentBudget, AgentRunLimits } from './agent-def';
import { screenedMoney } from './budget';
import { compareMoney } from './cost';
import { AiBudgetExceededError, AiRequestInvalidError } from './errors';

/** What one run is bounded by: the loop bounds, the deadline and the budget, after `limits()`. */
export interface RunCeilings {
  readonly bounds: AgentBounds;
  readonly deadlineMs: number | undefined;
  readonly budget: AgentBudget | undefined;
}

/** The key a refusal names: `limits().budget.tokensPerRun`, as the app's function wrote it. */
const KEY = 'limits()';

/**
 * The run's ceilings: `asked` screened like a declared bound (`finiteCount` — a `NaN` here would
 * switch a ceiling off), then held at or under `declared`. A higher value is refused, not clamped:
 * a function that asks for more than the declaration allows is a wrong rule, and clamping it
 * silently would hide that until a run needed the turns it was promised.
 */
export function narrowCeilings(
  agent: string,
  declared: RunCeilings,
  asked: AgentRunLimits | undefined,
): RunCeilings {
  if (asked === undefined) return declared;
  const lower = (
    key: string,
    value: number | undefined,
    ceiling: number | undefined,
    min: 0 | 1 = 0,
  ): number | undefined => {
    if (value === undefined) return ceiling;
    const screened = finiteCount(SUBJECT, `${KEY}.${key}`, value, min);
    if (ceiling !== undefined && screened > ceiling) refuseWider(agent, key, value, ceiling);
    return screened;
  };
  const { bounds } = declared;
  const repeats = lower(
    'maxRepeatedToolCalls',
    asked.maxRepeatedToolCalls,
    bounds.maxRepeatedToolCalls,
    1,
  );
  if (repeats !== undefined && repeats < 2) {
    throw new AiRequestInvalidError({
      detail: `agent "${agent}" limits() set maxRepeatedToolCalls to ${repeats}, which would stop the run at its first tool turn`,
      fix: 'maxRepeatedToolCalls: 2   # in what limits() returns — at least 2; it counts consecutive identical turns, the first included',
    });
  }
  const narrowed: AgentBounds = {
    maxTurns: lower('maxTurns', asked.maxTurns, bounds.maxTurns, 1) ?? bounds.maxTurns,
    maxTokens: lower('maxTokens', asked.maxTokens, bounds.maxTokens, 1) ?? bounds.maxTokens,
    maxToolResultChars:
      lower('maxToolResultChars', asked.maxToolResultChars, bounds.maxToolResultChars, 1) ??
      bounds.maxToolResultChars,
    maxRepeatedToolCalls: repeats ?? bounds.maxRepeatedToolCalls,
  };
  const deadlineMs = lower('deadlineMs', asked.deadlineMs, declared.deadlineMs, 1);
  return {
    bounds: narrowed,
    deadlineMs,
    budget: narrowBudget(agent, declared.budget, asked.budget),
  };
}

function narrowBudget(
  agent: string,
  declared: AgentBudget | undefined,
  asked: AgentBudget | undefined,
): AgentBudget | undefined {
  if (asked === undefined) return declared;
  const count = (key: 'tokensIn' | 'tokensPerRun'): number | undefined => {
    const value = asked[key];
    const ceiling = declared?.[key];
    if (value === undefined) return ceiling;
    const screened = finiteCount(SUBJECT, `${KEY}.budget.${key}`, value);
    if (ceiling !== undefined && screened > ceiling) {
      refuseWider(agent, `budget.${key}`, value, ceiling);
    }
    return screened;
  };
  const money = (key: 'costPerCall' | 'costPerRun'): Money | undefined => {
    const value = asked[key];
    const ceiling = declared?.[key];
    if (value === undefined) return ceiling;
    screenedMoney(SUBJECT, `${KEY}.budget.${key}`, value);
    if (ceiling !== undefined) {
      assertSameCurrency(ceiling, value);
      if (compareMoney(value, ceiling) > 0) {
        refuseWider(agent, `budget.${key}`, `${value.minor} ${value.currency}`, ceiling.minor);
      }
    }
    return value;
  };
  const tokensIn = count('tokensIn');
  const tokensPerRun = count('tokensPerRun');
  const costPerCall = money('costPerCall');
  const costPerRun = money('costPerRun');
  return {
    ...(tokensIn === undefined ? {} : { tokensIn }),
    ...(tokensPerRun === undefined ? {} : { tokensPerRun }),
    ...(costPerCall === undefined ? {} : { costPerCall }),
    ...(costPerRun === undefined ? {} : { costPerRun }),
  };
}

function refuseWider(agent: string, key: string, value: number | string, ceiling: number): never {
  throw new AiRequestInvalidError({
    detail: `agent "${agent}" limits() asked for ${key} ${value}, over the declared ${ceiling} — a run may only lower a declared ceiling`,
    fix: `${key}: ${ceiling}   # at most this in what limits() returns — or raise ${key} on the agent declaration first`,
  });
}

/**
 * `costPerRun`, before one turn: what the run has cost so far (every turn, every continuation,
 * every nested call reported up) plus this turn's worst-case estimate, against the ceiling. The
 * figures are compared at one scale and refused, never truncated, exactly as `costPerCall` is.
 */
export function assertRunCost(limit: Money, spent: Money, estimate: Money): void {
  assertSameCurrency(limit, spent);
  assertSameCurrency(limit, estimate);
  const scale = Math.max(commonScale(limit, spent), commonScale(limit, estimate));
  const ceiling = minorAt(limit, scale);
  const used = minorAt(spent, scale);
  const want = minorAt(estimate, scale);
  if (used + want <= ceiling) return;
  throw new AiBudgetExceededError({
    scope: 'costPerRun',
    requested: Number(want),
    remaining: Number(ceiling - used),
    limit: Number(ceiling),
    unit:
      scale === exponentOf(limit.currency)
        ? `${limit.currency} minor units`
        : `${limit.currency} at scale ${scale}`,
  });
}
