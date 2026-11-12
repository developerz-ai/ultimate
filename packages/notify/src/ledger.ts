// The delivery ledger: the row that makes a replayed attempt stop short of a second send.
//
// A `step.run` checkpoint is the FIRST layer and it is not enough on its own — a job body runs
// before its checkpoint lands, so an attempt killed between the provider's 200 and the step write
// replays the send. This is the second layer: the claim is taken atomically before the send, and a
// claim that already reads `sent` answers `false` and the fan-out skips.

import { finiteCount, uuidV7 } from '@ultimat3/core';

export const DELIVERY_STATUSES = ['sending', 'sent', 'failed'] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** A status column this package did not write is not a `DeliveryStatus`; the pg store reads one
 * back on every `find` and must not cast an unknown string through the type that decides whether a
 * notification is resent. */
export const isDeliveryStatus = (value: unknown): value is DeliveryStatus =>
  typeof value === 'string' && (DELIVERY_STATUSES as readonly string[]).includes(value);

/**
 * One delivery's identity: which notification, to whom, over which channel.
 *
 * `recipient` is `null` for a bulk channel and that is the whole difference between the two
 * arities at this layer — one row for the audience rather than one per address.
 */
export interface DeliveryClaim {
  readonly notifier: string;
  /** The notifier's `key` for this run — what makes two invocations the same notification. */
  readonly key: string;
  readonly recipient: string | null;
  readonly channel: string;
}

export interface DeliveryRecord extends DeliveryClaim {
  readonly status: DeliveryStatus;
  /** How many attempts have taken this claim. A `sent` row is never re-claimed, so this counts
   * crashes and provider failures, which is exactly what makes a flapping channel visible. */
  readonly attempts: number;
  readonly at: Date;
}

/**
 * What a claim answers, and the three are three because each asks something different of the caller.
 * `owned`: send, and settle under this id. `sent`: it went out, stop. `held`: a live attempt holds
 * it. This attempt must NOT send and must NOT read that as `sent` either, or a holder that then dies
 * is a notification nobody retries. `retryAfterMs` is what is left of the holder's window.
 */
export type DeliveryClaimAnswer =
  | { readonly outcome: 'owned'; readonly claimId: string }
  | { readonly outcome: 'sent' }
  | { readonly outcome: 'held'; readonly retryAfterMs: number };

export interface DeliveryLedger {
  /**
   * Take ownership of this delivery. A `failed` row is claimed at once.
   *
   * A row left `sending` IS re-claimable once its window has passed, deliberately: the alternative
   * is a notification that silently never arrives because the process that owned it died. Inside
   * the window it is `held`, so a second attempt running beside the first does not send too.
   * At-least-once is the guarantee this package offers and the honest one: a send outlasting the
   * window still overlaps its reclaimer.
   */
  claim(claim: DeliveryClaim, at: Date): Promise<DeliveryClaimAnswer>;
  /**
   * Record the outcome, if `claimId` still owns the row and it is still `sending`. `false` means it
   * did not, and nothing changed: a late attempt never moves its reclaimer's row, least of all from
   * `sent` back to `failed`. Only `sent` blocks a future claim.
   */
  settle(claim: DeliveryClaim, status: DeliveryStatus, at: Date, claimId: string): Promise<boolean>;
  find(claim: DeliveryClaim): Promise<DeliveryRecord | undefined>;
}

/**
 * How long a `sending` row belongs to the attempt that claimed it. Five minutes: past the 30 s a job
 * lease survives a dead worker by, and past any send a provider SDK's own timeout allows. Too short
 * is a duplicate send; too long is a crashed attempt's recipient waiting that much longer.
 */
export const DEFAULT_DELIVERY_RECLAIM_MS = 5 * 60 * 1000;

/**
 * The tuple as one string. `JSON.stringify` of an ARRAY rather than a joined separator: a
 * recipient id or a channel name containing the separator would otherwise collide two distinct
 * deliveries into one ledger row, and the failure mode is a notification nobody ever receives.
 * `recipient ?? ''` is the Postgres ledger's `coalesce(recipient, '')`: one identity, both stores.
 */
const keyOf = (claim: DeliveryClaim): string =>
  JSON.stringify([claim.notifier, claim.key, claim.recipient ?? '', claim.channel]);

export interface MemoryDeliveryLedgerOptions {
  /**
   * Rows kept before the oldest is evicted. A process-local ledger is a DEV ledger — it forgets
   * on restart and it is private to one replica — so it is bounded rather than allowed to grow
   * into the heap, and it says so by publishing `size`.
   */
  readonly max?: number;
  /** How long a `sending` row is held. Defaults to `DEFAULT_DELIVERY_RECLAIM_MS`. */
  readonly reclaimAfterMs?: number | undefined;
}

export const DEFAULT_MAX_DELIVERY_RECORDS = 10_000;

export interface MemoryDeliveryLedger extends DeliveryLedger {
  readonly size: number;
  /** Rows evicted for the cap. Non-zero means this ledger can no longer refuse a replay. */
  readonly dropped: number;
  clear(): void;
}

/**
 * The default, and honest about what it is: one process, no durability. Installed by a test and by
 * `x dev`; a deployment with more than one replica needs `postgresDeliveryLedger`, because a claim
 * this replica took is invisible to the one that replays the job.
 */
export function memoryDeliveryLedger(
  options: MemoryDeliveryLedgerOptions = {},
): MemoryDeliveryLedger {
  // `while (rows.size > max)` is the eviction, so a `max` that is not a number is not a large cap
  // — it is no cap, and this ledger grows into the heap of a process that was told it was bounded.
  // `??` guards nullish and `NaN` is not, so `Number(process.env.…)` on an unset variable arrives
  // here intact. A floor of 1 because a ledger that keeps zero rows cannot refuse a replay, which
  // is its one job, and it fails at it silently.
  const max = finiteCount(
    'memoryDeliveryLedger',
    'max',
    options.max ?? DEFAULT_MAX_DELIVERY_RECORDS,
    1,
  );
  const reclaimAfterMs = finiteCount(
    'memoryDeliveryLedger',
    'reclaimAfterMs',
    options.reclaimAfterMs ?? DEFAULT_DELIVERY_RECLAIM_MS,
    1,
  );
  const rows = new Map<string, { readonly record: DeliveryRecord; readonly claimId: string }>();
  let dropped = 0;

  const evict = (): void => {
    while (rows.size > max) {
      const oldest = rows.keys().next();
      if (oldest.done === true) return;
      rows.delete(oldest.value);
      dropped += 1;
    }
  };

  // Delete, then set: `Map.set` on a key it holds keeps the key's OLD place, so the row just
  // re-claimed `sending` (or just settled `sent`) stayed first in line for `evict` — and a row
  // evicted mid-flight is a claim the next attempt never sees: a concurrent second send.
  const put = (id: string, row: { readonly record: DeliveryRecord; readonly claimId: string }) => {
    rows.delete(id);
    rows.set(id, row);
  };

  return {
    get size(): number {
      return rows.size;
    },
    get dropped(): number {
      return dropped;
    },
    claim(claim, at) {
      const id = keyOf(claim);
      const existing = rows.get(id)?.record;
      if (existing?.status === 'sent') return Promise.resolve({ outcome: 'sent' });
      const reclaimAt = (existing?.at.getTime() ?? 0) + reclaimAfterMs;
      if (existing?.status === 'sending' && at.getTime() <= reclaimAt) {
        return Promise.resolve({ outcome: 'held', retryAfterMs: reclaimAt - at.getTime() });
      }
      const claimId = uuidV7();
      // The row it found keeps its own identity, as the pg `on conflict do update` does.
      const record: DeliveryRecord = {
        ...(existing ?? claim),
        status: 'sending',
        attempts: (existing?.attempts ?? 0) + 1,
        at,
      };
      put(id, { record, claimId });
      evict();
      return Promise.resolve({ outcome: 'owned', claimId });
    },
    settle(claim, status, at, claimId) {
      const id = keyOf(claim);
      const existing = rows.get(id);
      // No claim, no row: the pg `update` matches nothing, and a row written here would refuse
      // the claim after it — a notification dev never sends and production does.
      if (existing?.claimId !== claimId || existing.record.status !== 'sending') {
        return Promise.resolve(false);
      }
      put(id, { claimId, record: { ...existing.record, status, at } });
      return Promise.resolve(true);
    },
    find(claim) {
      return Promise.resolve(rows.get(keyOf(claim))?.record);
    },
    clear() {
      rows.clear();
      dropped = 0;
    },
  };
}
