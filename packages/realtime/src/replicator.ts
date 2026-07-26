// The `replicator` role: consume the change feed, normalize, publish to the transport. Nothing else.
//
// **Exactly one per database.** Two replicators on one slot means every change is fanned out twice:
// duplicate patches, duplicate lsns, and a client digest that can never converge. The invariant is
// enforced by a Postgres session-level advisory lock, not by deployment discipline:
//
//   SELECT pg_try_advisory_lock(hashtext('x:replicator:<slot>'))
//
// The lock is tied to the *session*, so a crashed replicator releases it automatically — no lease
// renewal, no fencing token, no split brain. A process that fails to take the lock does not start
// its feed and reports `/readyz` false; it retries with jittered backoff and takes over the moment
// the holder dies. Scaling the replicator is therefore always vertical, and that is by design.

import { logger, withSpan } from '@ultimat3/core';
import type { ChangeEvent, ChangeFeed } from './changefeed';
import type { Transport } from './fanout';
import { type BackoffPolicy, backoffDelay, defaultBackoff, type Rng } from './thundering-herd';

export const CHANGE_SUBJECT_PREFIX = 'x.change';

/** Session-scoped mutual exclusion. Postgres-backed in production, in-memory for `x dev`. */
export interface AdvisoryLock {
  readonly key: string;
  /** `false` means another process holds it — never block, never steal. */
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}

/** Single-process default: correct for `x dev` and tests, useless across containers (by design). */
export class InMemoryAdvisoryLock implements AdvisoryLock {
  static readonly #held = new Set<string>();
  readonly key: string;
  #mine = false;

  constructor(key: string) {
    this.key = key;
  }

  async tryAcquire(): Promise<boolean> {
    if (InMemoryAdvisoryLock.#held.has(this.key)) return false;
    InMemoryAdvisoryLock.#held.add(this.key);
    this.#mine = true;
    return true;
  }

  async release(): Promise<void> {
    if (!this.#mine) return;
    InMemoryAdvisoryLock.#held.delete(this.key);
    this.#mine = false;
  }
}

/** `x.change.<entity>.<orgId>` — tenant in the subject, so fanout filters without parsing a row. */
export function changeSubject(change: ChangeEvent): string {
  return `${CHANGE_SUBJECT_PREFIX}.${change.entity}.${change.orgId ?? '_'}`;
}

export interface ReplicatorOptions {
  readonly feed: ChangeFeed;
  readonly transport: Transport;
  readonly lock: AdvisoryLock;
  /** Resume position, normally the last lsn this replicator persisted. */
  readonly from?: string;
  readonly subjectOf?: (change: ChangeEvent) => string;
  readonly backoff?: BackoffPolicy;
  readonly rng?: Rng;
}

export interface ReplicatorStats {
  readonly published: number;
  readonly skipped: number;
  readonly outOfOrder: number;
}

export interface Replicator {
  /** `false` = another replicator holds the lock; this process must stay `/readyz` false. */
  start(): Promise<boolean>;
  stop(): Promise<void>;
  readonly running: boolean;
  lastLsn(): string | null;
  stats(): ReplicatorStats;
  /** Delay before the next takeover attempt, jittered so N standbys do not collide. */
  retryDelayMs(attempt: number): number;
}

export function createReplicator(options: ReplicatorOptions): Replicator {
  const subjectOf = options.subjectOf ?? changeSubject;
  const backoff = options.backoff ?? defaultBackoff;
  let running = false;
  let lastLsn: string | null = null;
  let published = 0;
  let skipped = 0;
  let outOfOrder = 0;

  const onChange = async (raw: ChangeEvent): Promise<void> => {
    const change = normalize(raw);
    if (!change) {
      skipped += 1;
      return;
    }
    if (lastLsn !== null && change.lsn <= lastLsn) {
      // At-least-once delivery is the feed's contract, so a repeat is expected, not an error.
      outOfOrder += 1;
      return;
    }
    await withSpan('realtime.replicate', async () => {
      await options.transport.publish(subjectOf(change), JSON.stringify(change));
      lastLsn = change.lsn;
      published += 1;
    });
  };

  return {
    async start(): Promise<boolean> {
      if (running) return true;
      if (!(await options.lock.tryAcquire())) {
        logger.warn('replicator standby: advisory lock held elsewhere', { key: options.lock.key });
        return false;
      }
      running = true;
      await options.feed.start(
        options.from === undefined ? { onChange } : { from: options.from, onChange },
      );
      logger.info('replicator started', { source: options.feed.source, key: options.lock.key });
      return true;
    },

    async stop(): Promise<void> {
      if (!running) return;
      running = false;
      await options.feed.stop();
      await options.lock.release();
    },

    get running(): boolean {
      return running;
    },

    lastLsn(): string | null {
      return lastLsn ?? options.feed.lastLsn();
    },

    stats(): ReplicatorStats {
      return { published, skipped, outOfOrder };
    },

    retryDelayMs(attempt: number): number {
      return backoffDelay(attempt, backoff, options.rng ?? Math.random);
    },
  };
}

/** Drops events the pipeline cannot use and hoists the tenant id out of the row. */
export function normalize(change: ChangeEvent): ChangeEvent | null {
  const row = change.after ?? change.before;
  if (!row) return null;
  if (change.op === 'insert' && change.after === null) return null;
  if (change.op === 'delete' && change.before === null) return null;
  if (change.orgId !== null) return change;
  const orgId = row['orgId'];
  return typeof orgId === 'string' ? { ...change, orgId } : change;
}

/** Sync-node side of the bus: decode a published change back into a `ChangeEvent`. */
export function parseChange(payload: string): ChangeEvent | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const shape = parsed as Partial<ChangeEvent>;
    if (typeof shape.entity !== 'string' || typeof shape.lsn !== 'string') return null;
    if (shape.op !== 'insert' && shape.op !== 'update' && shape.op !== 'delete') return null;
    return {
      entity: shape.entity,
      op: shape.op,
      before: shape.before ?? null,
      after: shape.after ?? null,
      lsn: shape.lsn,
      txid: typeof shape.txid === 'string' ? shape.txid : '',
      orgId: typeof shape.orgId === 'string' ? shape.orgId : null,
      at: typeof shape.at === 'number' ? shape.at : 0,
    };
  } catch {
    return null;
  }
}
