/**
 * Postly's `WebhookLedger` — the delivery mechanism's record, over the app's own
 * `webhook_deliveries` table. The framework ships the seam and never the table (retention is the
 * app's), and `memoryWebhookLedger()` is a heap ring that forgets on restart, so a production app
 * writes this file once. Every method runs inside the delivery's run, under the endpoint's org.
 */

import { WEBHOOK_ERROR_MAX } from '@postly/db';
import { isUltimateError } from '@ultimat3/core';
import type { WebhookAttempt, WebhookLedger } from '@ultimat3/jobs';
import { disableEndpoint, endpointById, insertDelivery, lastDelivery } from './repo';

/**
 * How many times one attempt re-reads after losing `(endpointId, seq)` to a concurrent one. Each
 * loss means another attempt to this endpoint landed in between, so the bound is the endpoint's
 * concurrent deliveries — never a wait.
 */
const SEQ_TRIES = 8;

/** The number this attempt picked was taken: `webhook_delivery_seq_unique`, the database's 23505. */
const seqTaken = (error: unknown): boolean =>
  isUltimateError(error) && error.code === 'X_DB_UNIQUE_VIOLATION';

/** The org a delivery row belongs to: the endpoint's own, read under the run's tenant. */
const ownerOf = async (endpointId: string): Promise<string | null> =>
  (await endpointById(endpointId))?.orgId ?? null;

/** One attempt as a row, numbered `seq` and carrying the count it leaves the endpoint at. */
const rowOf = (
  attempt: WebhookAttempt,
  orgId: string,
  seq: number,
  consecutiveFailures: number,
) => ({
  orgId,
  endpointId: attempt.endpointId,
  seq,
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

export const postlyWebhookLedger: WebhookLedger = {
  /**
   * Append the attempt and answer the endpoint's consecutive failures: the last row's count plus
   * one, or 0 on a success. Stored ON the row, so the next attempt reads one row rather than
   * counting back through history.
   *
   * NOT one attempt at a time: every event is its own delivery job, so two deliveries to one
   * endpoint can finish together and both read row N. `(endpointId, seq)` is unique, so the
   * database takes exactly one N+1 and the other re-reads — every count continues from the row
   * immediately before it, and no failure is lost to a stale read.
   */
  async record(attempt: WebhookAttempt): Promise<number> {
    const orgId = await ownerOf(attempt.endpointId);
    // The mechanism read this endpoint a moment ago; gone now means deleted mid-attempt, and its
    // rows cascade with it — there is nothing left to count toward.
    if (orgId === null) return 0;
    for (let tries = 1; ; tries += 1) {
      const previous = await lastDelivery(attempt.endpointId);
      const consecutiveFailures = attempt.ok ? 0 : (previous?.consecutiveFailures ?? 0) + 1;
      try {
        await insertDelivery(rowOf(attempt, orgId, (previous?.seq ?? 0) + 1, consecutiveFailures));
        return consecutiveFailures;
      } catch (error) {
        if (!seqTaken(error) || tries >= SEQ_TRIES) throw error;
      }
    }
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
