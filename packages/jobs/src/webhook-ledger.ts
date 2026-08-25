// The delivery ledger: what every outbound attempt is recorded in, and the one fact the mechanism
// reads back out of it — how many times in a row this endpoint has failed.
//
// A SEAM and not a table, exactly like `PurgeTarget`: an app already has a place for this and the
// retention on it is seven years for one business and thirty days for the next, so shipping a
// schema would be shipping one of those answers (axiom 8). What the framework owns is that every
// attempt IS recorded and that the count is what disables an endpoint.

import { assert } from '@ultimat3/core';

/** One outbound attempt, as it happened. Bounded and JSON-safe, so a row can hold it verbatim. */
export interface WebhookAttempt {
  /** The `webhook()` declaration's name — the durable queue key deliveries are routed under. */
  readonly webhook: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly topic: string;
  /** The JOB's attempt, 1-based: attempt 3 is the third time the queue handed this delivery out. */
  readonly attempt: number;
  readonly ok: boolean;
  /** The response status, or `null` when there was no response at all. */
  readonly status: number | null;
  /** When the attempt finished, in ms on the declaration's clock. */
  readonly at: number;
  readonly durationMs: number;
  /**
   * Why it failed, rendered by the framework and never by the receiver: the response BODY is not
   * here, because an endpoint that echoes the request has just written the payload into a second
   * table with a different retention. Absent on a success.
   */
  readonly error?: string;
}

export interface WebhookLedger {
  /**
   * Append this attempt and answer how many CONSECUTIVE failures the endpoint now has — 0 when
   * `attempt.ok`. One method rather than an append plus a separate count, so the number the
   * mechanism disables on cannot be read from before the row it is deciding about.
   */
  record(attempt: WebhookAttempt): Promise<number>;
  /**
   * Stop delivering to this endpoint. Called once, on the attempt whose count reached
   * `disableAfter`. Re-enabling is the app's — a dead endpoint that heals itself is a retry loop
   * with no end.
   */
  disable(endpointId: string, reason: string): Promise<void>;
}

/** Attempts one process keeps before the oldest go. A dev ledger that grows forever is a leak. */
export const DEFAULT_MAX_WEBHOOK_ATTEMPTS = 1_000;

export interface MemoryWebhookLedger extends WebhookLedger {
  /** Newest last, bounded by `maxAttempts`. */
  attempts(): readonly WebhookAttempt[];
  /** Endpoint id -> the reason it was disabled. */
  disabled(): ReadonlyMap<string, string>;
  reset(): void;
}

/**
 * The dev and test ledger, and honest about being one: a bounded ring in one heap, so nothing here
 * survives a restart and nothing here is shared between replicas. The consecutive count is derived
 * from a counter rather than by scanning the ring — a ring that evicted the failures would answer
 * a smaller number the longer an outage ran, which is the direction that never disables anything.
 */
export function memoryWebhookLedger(
  options: { readonly maxAttempts?: number } = {},
): MemoryWebhookLedger {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_WEBHOOK_ATTEMPTS;
  assert(
    Number.isSafeInteger(maxAttempts) && maxAttempts >= 1,
    `memoryWebhookLedger maxAttempts is ${String(maxAttempts)}, which keeps no attempt at all`,
    `pass memoryWebhookLedger({ maxAttempts: ${DEFAULT_MAX_WEBHOOK_ATTEMPTS} }) or leave it out — a ledger that holds nothing cannot disable an endpoint`,
  );
  const attempts: WebhookAttempt[] = [];
  const consecutive = new Map<string, number>();
  const off = new Map<string, string>();

  return {
    record(attempt: WebhookAttempt): Promise<number> {
      attempts.push(attempt);
      if (attempts.length > maxAttempts) attempts.splice(0, attempts.length - maxAttempts);
      const failures = attempt.ok ? 0 : (consecutive.get(attempt.endpointId) ?? 0) + 1;
      // Deleted at zero rather than written as one, the bound `limits.ts` keeps for the same
      // reason: a healthy endpoint must not cost a permanent map entry per org that creates one.
      if (failures === 0) consecutive.delete(attempt.endpointId);
      else consecutive.set(attempt.endpointId, failures);
      return Promise.resolve(failures);
    },
    disable(endpointId: string, reason: string): Promise<void> {
      off.set(endpointId, reason);
      return Promise.resolve();
    },
    attempts: (): readonly WebhookAttempt[] => [...attempts],
    disabled: (): ReadonlyMap<string, string> => new Map(off),
    reset(): void {
      attempts.length = 0;
      consecutive.clear();
      off.clear();
    },
  };
}
