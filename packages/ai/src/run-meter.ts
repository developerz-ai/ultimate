// Single responsibility: one run's meter — every provider call an `llm()` or an `agent()` makes
// goes through it, so the run always knows what it was billed, and a failure can say so.
//
// The ledger is not the place to read this from: a ledger is shared (a job's scope, an org's
// window), and the question a failed job asks is about THIS run.

import { isUltimateError } from '@ultimat3/core';
import type { AgentRunUsage } from './agent-usage';
import { addUsage } from './agent-usage';
import type { Billed } from './billed';
import { BILLED_META, billedOf } from './billed';
import { addMoney } from './cost';
import type { GenerateResult } from './provider';
import { ZERO_USAGE } from './wire';

export interface RunMeter {
  /**
   * Await one provider call. Until it reports usage it is UNSETTLED: an abort, a deadline or a
   * transport failure leaves it that way, and its bill cannot be known from here.
   */
  call(work: Promise<GenerateResult>): Promise<GenerateResult>;
  /** The run so far, re-priced from the summed usage — `undefined` before the first answer. */
  total(): AgentRunUsage | undefined;
  /** The run's bill, or `undefined` when no provider call was ever started. */
  billed(): Billed | undefined;
  /**
   * `error`, carrying the run's bill on `meta.billed`. Returned for a `throw`, never thrown here.
   * Only an `UltimateError` has a `meta` to carry it; anything else is returned untouched (the
   * ledger still holds the bill).
   */
  fail(error: unknown): unknown;
}

export function runMeter(): RunMeter {
  let own: AgentRunUsage | undefined;
  let calls = 0;
  let unsettled = 0;
  // Bills that arrived ON an error and were not priced by this meter: a provider's
  // `X_LLM_TOOL_ARGUMENTS_INVALID`, or a nested run's failure passing through.
  let carried: Billed | undefined;
  const counted = new WeakSet<object>();

  const absorb = (error: unknown): void => {
    const billed = billedOf(error);
    if (billed === undefined || typeof error !== 'object' || error === null) return;
    if (counted.has(error)) return;
    counted.add(error);
    carried = carried === undefined ? billed : sum(carried, billed);
  };

  const billed = (): Billed | undefined => {
    if (calls === 0 && unsettled === 0 && carried === undefined) return undefined;
    const mine: Billed = {
      usage: own?.usage ?? ZERO_USAGE,
      cost: own?.cost ?? carried?.cost ?? { minor: 0, currency: 'USD' },
      calls,
      unsettled,
    };
    if (carried === undefined) return mine;
    return own === undefined
      ? { ...carried, unsettled: carried.unsettled + unsettled }
      : sum(mine, carried);
  };

  return {
    async call(work) {
      unsettled += 1;
      try {
        const result = await work;
        unsettled -= 1;
        calls += 1;
        own = addUsage(own, result);
        return result;
      } catch (error) {
        // The provider answered and billed, then the answer could not be used: settled after all.
        if (billedOf(error) !== undefined) {
          unsettled -= 1;
          absorb(error);
        }
        throw error;
      }
    },
    total: () => own,
    billed,
    fail(error) {
      absorb(error);
      const bill = billed();
      if (bill === undefined || !isUltimateError(error)) return error;
      // An error is thrown once, by the run it failed, and `meta` is a plain own property the
      // constructor assigned. Written in place rather than wrapped: a wrapper would be a second
      // error with a different stack, and every reader upstream matches on the ORIGINAL's code.
      try {
        Reflect.set(error, 'meta', { ...error.meta, [BILLED_META]: bill });
      } catch {
        // A frozen error keeps the meta it was thrown with.
      }
      return error;
    },
  };
}

/** Two bills as one. A cost in another currency cannot be added and is left out of the sum. */
function sum(a: Billed, b: Billed): Billed {
  return {
    usage: {
      inputTokens: a.usage.inputTokens + b.usage.inputTokens,
      outputTokens: a.usage.outputTokens + b.usage.outputTokens,
      cacheReadTokens: a.usage.cacheReadTokens + b.usage.cacheReadTokens,
      cacheWriteTokens: a.usage.cacheWriteTokens + b.usage.cacheWriteTokens,
    },
    cost: a.cost.currency === b.cost.currency ? addMoney(a.cost, b.cost) : a.cost,
    calls: a.calls + b.calls,
    unsettled: a.unsettled + b.unsettled,
  };
}
