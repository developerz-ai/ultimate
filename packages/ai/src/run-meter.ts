// Single responsibility: one run's meter — every provider call an `llm()` or an `agent()` makes
// goes through it, so the run always knows what it was billed, and a failure can say so.
//
// The ledger is not the place to read this from: a ledger is shared (a job's scope, an org's
// window), and the question a failed job asks is about THIS run.

import { asyncContext, isUltimateError } from '@ultimat3/core';
import type { AgentRunUsage } from './agent-usage';
import { addUsage } from './agent-usage';
import type { Billed } from './billed';
import { BILLED_META, billedCall, billedOf } from './billed';
import { addMoney } from './cost';
import type { ModelFallback } from './model-fallback';
import { attemptsOf } from './model-fallback';
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
   * What was billed at ANOTHER model's price, added and never re-priced: runs underneath this one —
   * a tool that itself calls `llm()` or an `agent()` — and answers a `fallbackModels` model gave.
   * Their failures are read by the model as tool results and never thrown here, so this is the
   * only way that spend reaches the run that caused it.
   */
  below(): Billed | undefined;
  /** Run `fn` with this meter as the one nested runs report to. */
  within<T>(fn: () => T): T;
  /**
   * `error`, carrying the run's bill on `meta.billed`. Returned for a `throw`, never thrown here.
   * Only an `UltimateError` has a `meta` to carry it; anything else is returned untouched (the
   * ledger still holds the bill).
   */
  fail(error: unknown): unknown;
}

// The meter of the run in flight, so a run started underneath it can report upward.
const meters = asyncContext<{ report(bill: Billed): void }>('an AI run meter');

/** Errors a nested meter already reported upward: their `meta.billed` must not be added again. */
const reported = new WeakSet<object>();

export function runMeter(): RunMeter {
  const parent = meters.get();
  let nested: Billed | undefined;
  const report = (bill: Billed): void => {
    nested = nested === undefined ? bill : sum(nested, bill);
    parent?.report(bill);
  };
  let own: AgentRunUsage | undefined;
  let calls = 0;
  let unsettled = 0;
  // Bills that arrived ON an error and were not priced by this meter: a provider's
  // `X_LLM_TOOL_ARGUMENTS_INVALID`, or a nested run's failure passing through.
  let carried: Billed | undefined;
  const counted = new WeakSet<object>();

  /** Each failed model of a chain: its bill when it carried one, else one unsettled attempt. */
  const fellOver = (attempts: readonly ModelFallback[] | undefined): void => {
    for (const attempt of attempts ?? []) {
      const bill = attempt.billed ?? UNSETTLED_CALL;
      if (attempt.billed === undefined) unsettled += 1;
      else carried = carried === undefined ? bill : sum(carried, bill);
      parent?.report(bill);
    }
  };

  const absorb = (error: unknown): void => {
    const billed = billedOf(error);
    if (billed === undefined || typeof error !== 'object' || error === null) return;
    if (counted.has(error) || reported.has(error)) return;
    counted.add(error);
    carried = carried === undefined ? billed : sum(carried, billed);
  };

  const billed = (): Billed | undefined => {
    const direct = directBill();
    if (direct === undefined) return nested;
    return nested === undefined ? direct : sum(direct, nested);
  };
  const directBill = (): Billed | undefined => {
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
        if (fellOverTo(result)) {
          // Answered by a `fallbackModels` model: billed at ITS price, apart — `own` is re-priced
          // as one model, and summing a fallback's tokens into it charged them at the primary's.
          report(billedCall(result.usage, result.costExact ?? result.cost));
        } else {
          calls += 1;
          own = addUsage(own, result);
          parent?.report(billedCall(result.usage, result.costExact ?? result.cost));
        }
        // A `fallbackModels` chain's failed models were attempts too: each counted, never free.
        fellOver(result.fallbacks);
        return result;
      } catch (error) {
        // The provider answered and billed, then the answer could not be used: settled after all.
        const bill = billedOf(error);
        // A `fallbackModels` chain: every model it asked is an attempt, not the one call this
        // looked like — the earlier ones here, the one that threw below (unless the error IS the
        // chain's, every model declared-failed, and already counted whole).
        const chain = attemptsOf(error);
        fellOver(chain?.attempts);
        if (chain?.whole === true) {
          unsettled -= 1;
        } else if (bill !== undefined) {
          unsettled -= 1;
          absorb(error);
          parent?.report(bill);
        } else {
          // Never answered: its bill cannot be known, so it travels up as a count. Without this a
          // caught failure, or one beside a sibling that settled, vanished from the parent's total.
          parent?.report(UNSETTLED_CALL);
        }
        throw error;
      }
    },
    total: () => own,
    billed,
    below: () => nested,
    within: (fn) => meters.run({ report }, fn),
    fail(error) {
      absorb(error);
      // Everything this run was billed already reached the parent call by call.
      if (parent !== undefined && typeof error === 'object' && error !== null) reported.add(error);
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

/**
 * One bill across every `llm()` and `agent()` call `fn` makes, however deep they nest — what a
 * job reads to say what its run cost. A throw is rethrown carrying the total on `meta.billed`
 * (`billedOf(error)`); `billed` is `undefined` when no provider call was ever started. A meter,
 * not a ledger: it refuses nothing.
 */
export async function meteredRun<T>(
  fn: () => T | Promise<T>,
): Promise<{ readonly value: T; readonly billed: Billed | undefined }> {
  const meter = runMeter();
  try {
    const value = await meter.within(fn);
    return { value, billed: meter.billed() };
  } catch (error) {
    throw meter.fail(error);
  }
}

/** Answered on a fallback, not the model asked for. */
const fellOverTo = (result: GenerateResult): boolean => (result.fallbacks?.length ?? 0) > 0;

/** One started call that never reported usage: counted, never priced. */
const UNSETTLED_CALL: Billed = {
  usage: ZERO_USAGE,
  cost: { minor: 0, currency: 'USD' },
  calls: 0,
  unsettled: 1,
};

/**
 * Two bills as one. A cost in another currency cannot be added and is left out of the sum — except
 * a zero, which carries no currency worth keeping: an unsettled call's placeholder never decides it.
 */
function sum(a: Billed, b: Billed): Billed {
  return {
    usage: {
      inputTokens: a.usage.inputTokens + b.usage.inputTokens,
      outputTokens: a.usage.outputTokens + b.usage.outputTokens,
      cacheReadTokens: a.usage.cacheReadTokens + b.usage.cacheReadTokens,
      cacheWriteTokens: a.usage.cacheWriteTokens + b.usage.cacheWriteTokens,
    },
    cost:
      a.cost.currency === b.cost.currency
        ? addMoney(a.cost, b.cost)
        : a.cost.minor === 0
          ? b.cost
          : a.cost,
    calls: a.calls + b.calls,
    unsettled: a.unsettled + b.unsettled,
  };
}
