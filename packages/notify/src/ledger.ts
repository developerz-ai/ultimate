// The delivery ledger: the row that makes a replayed attempt stop short of a second send.
//
// A `step.run` checkpoint is the FIRST layer and it is not enough on its own — a job body runs
// before its checkpoint lands, so an attempt killed between the provider's 200 and the step write
// replays the send. This is the second layer: the claim is taken atomically before the send, and a
// claim that already reads `sent` answers `false` and the fan-out skips.

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

export interface DeliveryLedger {
  /**
   * Take ownership of this delivery. `true` means send; `false` means a completed row already
   * exists and this attempt must not send.
   *
   * A row left `sending` by a killed process IS re-claimable, deliberately: the alternative is a
   * notification that silently never arrives because the process that owned it died. At-least-once
   * is the guarantee this package offers and the honest one — `settle` is what closes the window.
   */
  claim(claim: DeliveryClaim, at: Date): Promise<boolean>;
  /** Record the outcome. Only `sent` blocks a future claim. */
  settle(claim: DeliveryClaim, status: DeliveryStatus, at: Date): Promise<void>;
  find(claim: DeliveryClaim): Promise<DeliveryRecord | undefined>;
}

/**
 * The tuple as one string. `JSON.stringify` of an ARRAY rather than a joined separator: a
 * recipient id or a channel name containing the separator would otherwise collide two distinct
 * deliveries into one ledger row, and the failure mode is a notification nobody ever receives.
 */
const keyOf = (claim: DeliveryClaim): string =>
  JSON.stringify([claim.notifier, claim.key, claim.recipient, claim.channel]);

export interface MemoryLedgerOptions {
  /**
   * Rows kept before the oldest is evicted. A process-local ledger is a DEV ledger — it forgets
   * on restart and it is private to one replica — so it is bounded rather than allowed to grow
   * into the heap, and it says so by publishing `size`.
   */
  readonly max?: number;
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
 * `x dev`; a deployment with more than one replica needs `createPgDeliveryLedger`, because a claim
 * this replica took is invisible to the one that replays the job.
 */
export function createMemoryDeliveryLedger(
  options: MemoryLedgerOptions = {},
): MemoryDeliveryLedger {
  const max = options.max ?? DEFAULT_MAX_DELIVERY_RECORDS;
  const rows = new Map<string, DeliveryRecord>();
  let dropped = 0;

  const evict = (): void => {
    while (rows.size > max) {
      const oldest = rows.keys().next();
      if (oldest.done === true) return;
      rows.delete(oldest.value);
      dropped += 1;
    }
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
      const existing = rows.get(id);
      if (existing?.status === 'sent') return Promise.resolve(false);
      rows.set(id, {
        ...claim,
        status: 'sending',
        attempts: (existing?.attempts ?? 0) + 1,
        at,
      });
      evict();
      return Promise.resolve(true);
    },
    settle(claim, status, at) {
      const id = keyOf(claim);
      const existing = rows.get(id);
      rows.set(id, { ...claim, status, attempts: existing?.attempts ?? 1, at });
      return Promise.resolve();
    },
    find(claim) {
      return Promise.resolve(rows.get(keyOf(claim)));
    },
    clear() {
      rows.clear();
      dropped = 0;
    },
  };
}
