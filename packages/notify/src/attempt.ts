// One delivery attempt, ledger-first. Every send in this package goes through here, so there is
// exactly one place that decides "has this already gone out" and exactly one that records the
// answer.
//
// The order is claim → send → settle, and it is not interchangeable. Settling first would mark a
// send that has not happened; claiming after would let two attempts pass the check together.

import type { Ctx } from '@ultimat3/core';
import { logger } from '@ultimat3/core';
import { NotifyDeliveryFailedError, NotifyDeliveryHeldError } from './errors';
import type { DeliveryClaim, DeliveryLedger, DeliveryStatus } from './ledger';

export interface AttemptInput {
  readonly ledger: DeliveryLedger;
  readonly claim: DeliveryClaim;
  readonly notifier: string;
  readonly channel: string;
  /** How many addresses this one attempt covers — 1 for an individual channel, the audience for
   * a bulk one. Reported in the refusal, because "the Slack post failed" and "one of 400 emails
   * failed" are different incidents. */
  readonly recipients: number;
  /** The job's clock, and nothing else: `send` closes over the rest. */
  readonly ctx: Pick<Ctx, 'now'>;
  send(signal: AbortSignal): Promise<void> | void;
}

/**
 * `true` when this attempt sent, `false` when the ledger already held a completed delivery — the
 * replay case, and the whole reason this function exists.
 *
 * A claim another attempt holds raises `X_NOTIFY_DELIVERY_HELD`, never `false`: `false` checkpoints
 * the step as done, and a holder that then dies is a notification no retry is left to send.
 *
 * A throwing channel settles `failed` and then rethrows as `X_NOTIFY_DELIVERY_FAILED`: the row
 * stays re-claimable, so the job's own retry policy decides whether it goes out, and the dead
 * letter names the channel rather than whatever the provider's SDK threw.
 */
export async function attemptDelivery(input: AttemptInput, signal: AbortSignal): Promise<boolean> {
  const answer = await input.ledger.claim(input.claim, input.ctx.now());
  if (answer.outcome === 'sent') return false;
  if (answer.outcome === 'held') {
    throw new NotifyDeliveryHeldError({
      notifier: input.notifier,
      channel: input.channel,
      retryAfterMs: answer.retryAfterMs,
    });
  }
  const settle = async (status: DeliveryStatus): Promise<void> => {
    const recorded = await input.ledger.settle(
      input.claim,
      status,
      input.ctx.now(),
      answer.claimId,
    );
    // The one trace of a send that outlasted its window: its reclaimer may have sent as well.
    if (!recorded) {
      logger.warn('notify.settle_fenced', {
        notifier: input.notifier,
        channel: input.channel,
        status,
      });
    }
  };
  try {
    await input.send(signal);
  } catch (error) {
    await settle('failed');
    throw new NotifyDeliveryFailedError({
      notifier: input.notifier,
      channel: input.channel,
      recipients: input.recipients,
      cause: error,
    });
  }
  await settle('sent');
  return true;
}
