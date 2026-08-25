// One delivery attempt, ledger-first. Every send in this package goes through here, so there is
// exactly one place that decides "has this already gone out" and exactly one that records the
// answer.
//
// The order is claim → send → settle, and it is not interchangeable. Settling first would mark a
// send that has not happened; claiming after would let two attempts pass the check together.

import type { Ctx } from '@ultimat3/core';
import { NotifyDeliveryFailedError } from './errors';
import type { DeliveryClaim, DeliveryLedger } from './ledger';

export interface AttemptInput {
  readonly ledger: DeliveryLedger;
  readonly claim: DeliveryClaim;
  readonly notifier: string;
  readonly channel: string;
  /** How many addresses this one attempt covers — 1 for an individual channel, the audience for
   * a bulk one. Reported in the refusal, because "the Slack post failed" and "one of 400 emails
   * failed" are different incidents. */
  readonly recipients: number;
  readonly ctx: Ctx;
  send(signal: AbortSignal): Promise<void> | void;
}

/**
 * `true` when this attempt sent, `false` when the ledger already held a completed delivery — the
 * replay case, and the whole reason this function exists.
 *
 * A throwing channel settles `failed` and then rethrows as `X_NOTIFY_DELIVERY_FAILED`: the row
 * stays re-claimable, so the job's own retry policy decides whether it goes out, and the dead
 * letter names the channel rather than whatever the provider's SDK threw.
 */
export async function attemptDelivery(input: AttemptInput, signal: AbortSignal): Promise<boolean> {
  if (!(await input.ledger.claim(input.claim, input.ctx.now()))) return false;
  try {
    await input.send(signal);
  } catch (error) {
    await input.ledger.settle(input.claim, 'failed', input.ctx.now());
    throw new NotifyDeliveryFailedError({
      notifier: input.notifier,
      channel: input.channel,
      recipients: input.recipients,
      cause: error,
    });
  }
  await input.ledger.settle(input.claim, 'sent', input.ctx.now());
  return true;
}
