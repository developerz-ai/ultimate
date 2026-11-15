// Single responsibility: the gateway's per-call arithmetic that is not routing — a failed call's
// settle, the abort test, a cache hit's zero bill, the screened completion ceiling and the
// response cache key. Split from ./gateway at its line ceiling; ./gateway re-exports the key.

import { fingerprint, finiteCount } from '@ultimat3/core';
import type { Billed } from './billed';
import { billedOf } from './billed';
import type { BudgetLedger, BudgetReservation } from './budget';
import type { GenerateRequest, GenerateResult } from './provider';
import { ZERO_USAGE } from './wire';

/**
 * A failed call's reservation: reconciled against its bill when the failure carries one — else
 * against `running`, what a stream's wire reported before it stopped — else given back.
 */
export async function settleFailure(
  ledger: BudgetLedger | undefined,
  reservation: BudgetReservation | undefined,
  error: unknown,
  running?: Billed,
): Promise<void> {
  const billed = billedOf(error) ?? running;
  if (billed === undefined) return ledger?.release(reservation);
  await ledger?.record(billed.usage, billed.cost, reservation);
}

/** The caller's abort — its signal, or the `AbortError` a fetch raises for it. */
export function abortedBy(request: GenerateRequest, error: unknown): boolean {
  if (request.signal?.aborted === true) return true;
  return error instanceof Error && error.name === 'AbortError';
}

/** The stored answer as a hit delivers it: no token spent, no money, in the currency it named. */
export const freeOf = (stored: GenerateResult): GenerateResult => ({
  ...stored,
  usage: ZERO_USAGE,
  cost: { ...stored.cost, minor: 0 },
  ...(stored.costExact === undefined ? {} : { costExact: { ...stored.costExact, minor: 0 } }),
});

/**
 * The request's completion ceiling, screened at the one seam every model call in an app passes
 * through — `llm()`, `agent()`, an eval, a judge and a hand-built `generate()` alike.
 *
 * It is not the request that a `NaN` here breaks, and that is why it is refused before anything
 * else happens: `maxTokens` IS the pre-flight estimate, `want > remaining` is false for a `NaN`
 * want, and `BudgetLedger.debit` then writes it onto the ambient ledger and the per-process
 * `BudgetStore`. Both counters are `NaN` from then on, so every later comparison against them is
 * false too — one unscreened declaration turns off every actor and org ceiling in the process,
 * permanently, and reports nothing. Screened before the reservation, so the ledger never sees it.
 */
export function ceilingOf(request: GenerateRequest): number {
  return finiteCount('the AI gateway', 'maxTokens', request.maxTokens, 1);
}

/**
 * Cache key. Every field that changes the answer is in it — a key that ignores `effort` or
 * `system` would serve one prompt's answer for another — and each tool WHOLE: every `llm()` tool
 * is named `respond`, so a key over names alone served an answer shaped for an old `output` schema
 * after the schema changed. Core's `fingerprint`, so key order never splits one request in two and
 * the width is the one every other sharing key in the framework has.
 */
export function promptCacheKey(request: GenerateRequest): string {
  return fingerprint({
    model: request.model,
    system: request.system ?? '',
    messages: request.messages,
    maxTokens: request.maxTokens,
    effort: request.effort ?? 'high',
    thinking: request.thinking ?? 'adaptive',
    tools: request.tools ?? [],
    stop: request.stopSequences ?? [],
    // Only when asked for: an absent knob must leave every key written before it existed as it was.
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    // A wire parameter changes the answer; absent leaves every older key as it was.
    ...(request.providerOptions === undefined ? {} : { providerOptions: request.providerOptions }),
  });
}
