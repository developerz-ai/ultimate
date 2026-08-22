// The in-process replicator: committed row changes in, `ChangeEvent`s out, fanned into the node.
//
// Production decodes the write-ahead log. PGlite has no walsender and the memory driver has no log,
// so a test process had no change source at all — which is what left the `subscribe` fixture with
// no driver, and its five tests in `examples/dummy` asserting against a snapshot that never moved.
//
// WHAT IS REAL HERE, and it is everything downstream of the decoder: the matcher, the shared window,
// the per-subscriber `visible` gate, the cursor, the frames. This substitutes for the WAL DECODER
// and for nothing else — `@ultimat3/entity`'s `setRowObserver` reports what a repository wrote, in
// this process, and the events are shaped exactly as `PgLogicalReplicationFeed` shapes them.
//
// WHAT IS NOT: a write another process made is invisible, because nothing here reads a log. That is
// the honest bound, and it is why this is a fixture and not a `ChangeFeed` — `selectChangeFeed`
// still decides what a real node reads, and this is never in that decision.

import type { RowBulkChange, RowChange, RowObserver } from '@ultimat3/entity';
import type { Row } from '@ultimat3/realtime';
import type { ChangeEvent, ChangeOp, LiveQueryRegistry } from '@ultimat3/realtime/server';

/** What a caller does with a change nobody could deliver. */
export interface LiveReplicatorOptions {
  readonly registry: LiveQueryRegistry;
  /** Tenant column, hoisted out of the row so fanout filters without parsing it. */
  readonly tenantColumn?: string;
  readonly onError?: (error: unknown) => void;
}

export interface LiveReplicator {
  /** Resolves when every change observed so far has been fanned out. Never a sleep. */
  settled(): Promise<void>;
  /** Changes this replicator has delivered — the number a test asserts a patch count against. */
  readonly delivered: number;
  stop(): void;
}

const OPS: Readonly<Record<RowChange['op'], ChangeOp>> = {
  insert: 'insert',
  update: 'update',
  delete: 'delete',
};

/**
 * A `ChangeEvent` row is `Row` — a JSON object carrying an `id`. Every row a repository stores has
 * one; the cast is what says so to a compiler that only sees `Record<string, unknown>`, and a row
 * that genuinely has none fails downstream in `idOf`, with the entity named, exactly as a row off
 * the wire would.
 */
const asRow = (value: Readonly<Record<string, unknown>> | null): Row | null =>
  value === null ? null : (value as unknown as Row);

/**
 * Lexicographically comparable, which is the whole contract of an lsn — `formatLsn` in
 * `@ultimat3/realtime` produces the same shape from a real WAL position. A counter is enough here
 * because one process observes its own writes in the order it made them.
 */
const lsnOf = (position: number): string => position.toString(16).padStart(16, '0');

/**
 * Install the replicator for the length of one test. It takes over the process row observer and
 * hands back whatever was installed before, because `bun test` shares one process across files and
 * an unconditional clear would take an outer harness's observer with it.
 */
export async function startLiveReplicator(options: LiveReplicatorOptions): Promise<LiveReplicator> {
  // Awaited BEFORE the observer exists, so installation is the last thing this function does and
  // no write between the call and the install can slip past unobserved.
  const entity = await import('@ultimat3/entity');
  const { registry } = options;
  const tenant = options.tenantColumn ?? 'orgId';
  let position = 0;
  let delivered = 0;
  // One promise chain, because ORDERING is the guarantee the whole pipeline is built on — the same
  // reason `InMemoryChangeFeed` serializes its deliveries rather than firing them concurrently.
  let tail: Promise<void> = Promise.resolve();
  let stopped = false;

  const enqueue = (work: () => Promise<void>): void => {
    tail = tail.then(work).catch((error: unknown) => {
      // Never rethrown into the chain: one failed fanout must not silence every change behind it,
      // and a rejection with nobody to hand it to ends the Bun process.
      options.onError?.(error);
    });
  };

  const observer: RowObserver = {
    onChange(change: RowChange): void {
      if (stopped) return;
      position += 1;
      const at = position;
      const row = change.after ?? change.before;
      const orgId = typeof row?.[tenant] === 'string' ? (row[tenant] as string) : null;
      const event: ChangeEvent = {
        entity: change.entity,
        op: OPS[change.op],
        before: asRow(change.before),
        after: asRow(change.after),
        lsn: lsnOf(at),
        txid: String(at),
        orgId,
        // Deliberately not a clock read: the preload freezes `Date.now()`, and a change's commit
        // time is not something any assertion in this repo reads. `at` keeps it monotonic anyway.
        at,
      };
      enqueue(async () => {
        delivered += await registry.deliver(event);
      });
    },

    /**
     * A filtered write names rows this seam never saw, so there is no event to shape. Every window
     * on the node is marked stale instead and re-read on the next change — `invalidate()` is the
     * node's own answer to "the change stream skipped something", used here for the one write that
     * genuinely does. Silence would be the alternative, and a subscriber told nothing happened
     * diverges with nobody ever asking again.
     */
    onBulk(_change: RowBulkChange): void {
      if (stopped) return;
      registry.invalidate();
    },
  };

  const previous = entity.setRowObserver(observer);

  return {
    get delivered() {
      return delivered;
    },
    settled: async () => {
      // Twice: a fanout can enqueue nothing, but the writes that produced these changes may still
      // be resolving their own promises when a test asks. Awaiting the chain, letting the
      // microtask queue drain, then awaiting it again covers a change observed in between.
      await tail;
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      await tail;
    },
    stop: () => {
      stopped = true;
      // Restored, never cleared: one process runs every test file, and an outer harness's observer
      // must survive an inner fixture finishing.
      entity.setRowObserver(previous);
    },
  };
}
