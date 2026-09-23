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
// the honest bound, and it is why `selectChangeFeed` never picks it — the boot that installs it
// decides, and only under an embedded database.
//
// Lives in `@ultimat3/realtime/server` since 2026-09-23: it imports only `entity` and `realtime`,
// so it is a second change source beside the WAL decoder, and `x dev` booting it out of
// `@ultimat3/testing` put the test harness in every dev process's graph. `@ultimat3/testing`
// re-exports it until 22.0.0.
//
// `x dev` is the one boot that installs it outside a test, `As of 2026-09-05` (`@ultimat3/cli`'s
// `dev-live-feed.ts`), and only under the EMBEDDED database: PGlite has no walsender, every role
// runs in that one process, so the bound above holds by construction — and a real `DATABASE_URL`
// gets the decoder instead, never both.

import type { RowBulkChange, RowChange, RowObserver } from '@ultimat3/entity';
import type { ChangeEvent, ChangeOp } from './changefeed';
import type { Row } from './json';
import type { LiveQueryRegistry } from './live-query';

/** What a caller does with a change nobody could deliver. */
export interface LiveReplicatorOptions {
  readonly registry: LiveQueryRegistry;
  /**
   * The node's declared channels, fed the same `ChangeEvent` — what a real node's change
   * subscription does beside `registry.deliver` (`sync-node.ts`). Without it a channel's `records`
   * frames never carried a write made under `x dev`, and every other tab stayed on the old row.
   */
  readonly channels?: { deliverChange(change: ChangeEvent): unknown };
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
        // A repository's three row ops are three of the feed's four; a truncate never comes this way.
        op: change.op satisfies ChangeOp,
        before: asRow(change.before),
        after: asRow(change.after),
        lsn: lsnOf(at),
        txid: String(at),
        orgId,
        // Deliberately not a clock read: the preload freezes `Date.now()`, and a change's commit
        // time is not something any assertion in this repo reads. `at` keeps it monotonic anyway.
        at,
        // The keyed write it belongs to, read off the request scope — what the WAL decoder reads
        // off the transaction's opening message — so a channel frame names it here as it would there.
        ...(change.write === undefined ? {} : { write: change.write }),
      };
      enqueue(async () => {
        // Channels first, as the node does: a live query's fanout that throws must not also cost
        // every declared channel the change.
        options.channels?.deliverChange(event);
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
