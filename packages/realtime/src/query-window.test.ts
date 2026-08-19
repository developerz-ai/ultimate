// What a window that is known to be wrong owes the next reader. The rule under test: `stale` is
// cleared by a read that ANSWERED, never by one that was merely issued — a snapshot that rejects
// leaves the mark it was sent to clear, or the gap repair happens exactly once and never again.

import { describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { type ChangeEvent, formatLsn } from './changefeed';
import type { JsonValue, Row } from './json';
import type { LiveQueryDefinition, SnapshotResult } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import { createEntry, fillWindow, type QueryEntry, refillWindowInLane } from './query-window';
import { SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

const input: JsonValue = { orgId: 'o1' };
const rows: readonly Row[] = [{ id: 'p1', orgId: 'o1', likes: 0 }];

class PoolTimeout extends Error {
  readonly code = 'X_DB_TIMEOUT';
}

/** A definition whose read is driven from the test: one answer per call, in order. */
function entryWith(snapshot: () => Promise<SnapshotResult>): QueryEntry {
  const definition: LiveQueryDefinition = {
    name: 'liveFeed',
    entities: ['posts'],
    snapshot,
    visible: () => true,
    matcher: () => ({ entities: ['posts'], match: () => ({ patches: [], refill: false }) }),
  };
  return createEntry('liveFeed:1', definition, input, definition.matcher(input));
}

describe('a read that never answered does not clear the staleness it was sent to clear', () => {
  test('a rejecting refill leaves the window stale, so the next change re-reads', async () => {
    const entry = entryWith(async () => {
      throw new PoolTimeout('connection pool exhausted');
    });
    entry.stale = true;

    await expect(refillWindowInLane(entry)).rejects.toThrow(PoolTimeout);

    // The pool died during the same incident that caused the gap. Cleared here, `#resnapshot`
    // re-serves every desynced subscriber out of the window the gap already invalidated and
    // clears their marks: permanent, silent divergence with nothing left to notice it.
    expect(entry.stale).toBe(true);
    expect(entry.rows).toEqual([]);
  });

  test('a rejecting forced fillWindow leaves it stale too', async () => {
    const entry = entryWith(async () => {
      throw new PoolTimeout('connection pool exhausted');
    });
    entry.stale = true;

    await expect(fillWindow(entry)).rejects.toThrow(PoolTimeout);

    expect(entry.stale).toBe(true);
  });

  test('a snapshot that throws synchronously is a rejection, not a lost mark', async () => {
    const entry = entryWith(() => {
      throw new PoolTimeout('pool is closed');
    });
    entry.stale = true;

    await expect(fillWindow(entry)).rejects.toThrow(PoolTimeout);

    expect(entry.stale).toBe(true);
  });

  test('a read that ANSWERS clears it, and its rows replace the window', async () => {
    const entry = entryWith(async () => ({ rows, lsn: formatLsn(4) }));
    entry.stale = true;

    await expect(refillWindowInLane(entry)).resolves.toBeUndefined();

    expect(entry.stale).toBe(false);
    expect(entry.rows).toEqual(rows);
    expect(entry.lsn).toBe(formatLsn(4));
  });

  test('the failed read is not left in flight for the next caller to join', async () => {
    let reads = 0;
    const entry = entryWith(async () => {
      reads += 1;
      if (reads === 1) throw new PoolTimeout('connection pool exhausted');
      return { rows, lsn: formatLsn(4) };
    });
    entry.stale = true;

    await expect(fillWindow(entry)).rejects.toThrow(PoolTimeout);
    // Still stale, so this one forces its own read rather than being served the window the
    // failure left behind.
    await expect(fillWindow(entry)).resolves.toEqual({ rows, lsn: formatLsn(4) });

    expect(reads).toBe(2);
    expect(entry.stale).toBe(false);
  });
});

class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  send(data: string): number {
    this.frames.push(decode(data));
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

const change = (position: number, after: Row): ChangeEvent => ({
  entity: 'posts',
  op: 'update',
  before: rows[0] as Row,
  after,
  lsn: formatLsn(position),
  txid: String(position),
  orgId: 'o1',
  at: 1_000,
});

describe('the gap repair, end to end', () => {
  test('a refill that failed is retried on the next change instead of served from', async () => {
    let reads = 0;
    let broken = false;
    const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register({
      name: 'liveFeed',
      entities: ['posts'],
      snapshot: async () => {
        if (broken) throw new PoolTimeout('connection pool exhausted');
        reads += 1;
        return { rows, lsn: formatLsn(1) };
      },
      visible: () => true,
      matcher: () => ({
        entities: ['posts'],
        match: (event) => {
          const patch = patchFromChange(event);
          return { patches: patch ? [patch] : [], refill: false };
        },
      }),
    });
    const ws = new FakeWs();
    const socket = new SyncSocket({
      ws,
      id: 's-alice',
      clientBuildId: 'build-1',
      serverBuildId: 'build-1',
      actor: userActor({ id: 'alice', orgId: 'o1' }),
    });
    const { subscription } = await registry.subscribe({ socket, name: 'liveFeed', input });
    expect(reads).toBe(1);

    // The sequence gap: every window presumed to have missed a change, every subscriber desynced.
    registry.invalidate();
    broken = true;
    await expect(registry.deliver(change(2, { id: 'p1', orgId: 'o1', likes: 1 }))).rejects.toThrow(
      PoolTimeout,
    );

    broken = false;
    await registry.deliver(change(3, { id: 'p1', orgId: 'o1', likes: 2 }));

    // The read the failed one owed. Cleared-on-issue, this was 1 forever and the subscriber was
    // re-snapshotted out of the pre-gap window with its desync mark wiped.
    expect(reads).toBe(2);
    expect(socket.desynced.has(subscription.sid)).toBe(false);
  });
});

/**
 * Two reads in flight over one entry, landing out of order. The never-backwards rule was expressed
 * purely in lsn terms, and a definition with no lsn provider answers `''` for every read — so
 * `'' >= ''` let the OLDER read overwrite the newer one, with `stale` already cleared by the newer
 * one's issue. Nothing re-reads after that: `fanoutChange`'s repair only fires on `entry.stale`, so
 * every subscriber of that query id is served out of the pre-gap window for the life of the entry.
 */
describe('an older read never lands on a window a newer one already replaced', () => {
  /** One entry whose snapshot is resolved by the test, in whatever order it likes. */
  function deferred(): { entry: QueryEntry; answer: (at: number, rows: readonly Row[]) => void } {
    const gate: ((result: SnapshotResult) => void)[] = [];
    const entry = entryWith(
      async () =>
        await new Promise<SnapshotResult>((resolve) => {
          gate.push(resolve);
        }),
    );
    return {
      entry,
      answer: (at, answered) => {
        // No lsn: the shape `toLiveQuery` produces for a definition with no lsn provider, and the
        // one the guard could not tell apart from "older".
        gate[at]?.({ rows: answered, lsn: '' });
      },
    };
  }

  const preGap: readonly Row[] = [{ id: 'pre-gap' }];
  const fresh: readonly Row[] = [{ id: 'fresh' }];

  test('the pre-gap read that resolves last is discarded, not applied over the repair', async () => {
    const { entry, answer } = deferred();

    // T0 — a cold subscriber: nothing in flight and nothing stale, so this issues read P1.
    const first = fillWindow(entry);
    // T1 — the change stream skipped a sequence: `registry.invalidate()` marks every window.
    entry.stale = true;
    // T2 — a second cold subscriber forces its own read, P2, clearing the mark on the way in.
    const second = fillWindow(entry);
    expect(entry.stale).toBe(false);

    // T3 — P2 answers with the post-gap rows, which is the repair.
    answer(1, fresh);
    await expect(second).resolves.toEqual({ rows: fresh, lsn: '' });
    // T4 — the OLDER read finally answers.
    answer(0, preGap);

    await expect(first).resolves.toEqual({ rows: fresh, lsn: '' });
    expect(entry.rows).toEqual(fresh);
  });

  test('a refill in the lane is not overwritten by a read issued before it', async () => {
    const { entry, answer } = deferred();

    const joining = fillWindow(entry);
    const repair = refillWindowInLane(entry);
    answer(1, fresh);
    await expect(repair).resolves.toBeUndefined();
    answer(0, preGap);

    await expect(joining).resolves.toEqual({ rows: fresh, lsn: '' });
    expect(entry.rows).toEqual(fresh);
  });

  test('the newest read still lands — the guard discards older reads, not every read', async () => {
    const { entry, answer } = deferred();

    const first = fillWindow(entry);
    entry.stale = true;
    const second = fillWindow(entry);

    // The older one answers FIRST this time, so the forced read is still the newest to land.
    answer(0, preGap);
    await expect(first).resolves.toEqual({ rows: preGap, lsn: '' });
    answer(1, fresh);

    await expect(second).resolves.toEqual({ rows: fresh, lsn: '' });
    expect(entry.rows).toEqual(fresh);
  });
});
