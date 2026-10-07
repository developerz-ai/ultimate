/**
 * Postly's `WebhookLedger` — the delivery mechanism's record, over the app's own
 * `webhook_deliveries` table. The framework ships the seam and never the table (retention is the
 * app's), and `memoryWebhookLedger()` is a heap ring that forgets on restart, so a production app
 * writes this file once. Every method runs inside the delivery's run, under the endpoint's org.
 */

import { WEBHOOK_ERROR_MAX } from '@postly/db';
import type { WebhookAttempt, WebhookLedger } from '@ultimat3/jobs';
import { disableEndpoint, endpointById, insertDelivery, lastDelivery } from './repo';

/** The org a delivery row belongs to: the endpoint's own, read under the run's tenant. */
const ownerOf = async (endpointId: string): Promise<string | null> =>
  (await endpointById(endpointId))?.orgId ?? null;

export const postlyWebhookLedger: WebhookLedger = {
  /**
   * Append the attempt and answer the endpoint's consecutive failures: the last row's count plus
   * one, or 0 on a success. Stored ON the row, so the next attempt reads one row rather than
   * counting back through history — the same "last one plus one" `runs/repo.ts` numbers events by,
   * and safe for the same reason: one delivery to one endpoint is one attempt at a time.
   */
  async record(attempt: WebhookAttempt): Promise<number> {
    const orgId = await ownerOf(attempt.endpointId);
    // The mechanism read this endpoint a moment ago; gone now means deleted mid-attempt, and its
    // rows cascade with it — there is nothing left to count toward.
    if (orgId === null) return 0;
    const previous = await lastDelivery(attempt.endpointId);
    const consecutiveFailures = attempt.ok ? 0 : (previous?.consecutiveFailures ?? 0) + 1;
    await insertDelivery({
      orgId,
      endpointId: attempt.endpointId,
      webhook: attempt.webhook,
      eventId: attempt.eventId,
      topic: attempt.topic,
      attempt: attempt.attempt,
      ok: attempt.ok,
      status: attempt.status,
      durationMs: Math.round(attempt.durationMs),
      // Rendered by the framework and bounded by the column: the tail of a long cause is noise.
      error: attempt.error === undefined ? null : attempt.error.slice(0, WEBHOOK_ERROR_MAX),
      consecutiveFailures,
      at: new Date(attempt.at),
    });
    return consecutiveFailures;
  },

  async disable(endpointId: string, reason: string): Promise<void> {
    await disableEndpoint(endpointId, reason);
  },

  /** Answered from the column `disable` sets — the one place the verdict lives. */
  async isDisabled(endpointId: string): Promise<boolean> {
    const endpoint = await endpointById(endpointId);
    return endpoint !== null && endpoint.disabledReason !== null;
  },
};
