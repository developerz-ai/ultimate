// What a window that is known to be wrong owes the next reader. The rule under test: `stale` is
// cleared by a read that ANSWERED, never by one that was merely issued — a snapshot that rejects
// leaves the mark it was sent to clear, or the gap repair happens exactly once and never again.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, userActor } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { type ChangeEvent, formatLsn } from './changefeed';
import type { JsonValue, Row } from './json';
import type { LiveQueryDefinition, SnapshotResult } from './live-contract';
import { LiveQueryRegistry } from './live-query';
import { patchFromChange } from './matcher-bridge';
import {
  createEntry,
  DEFAULT_READ_DEADLINE_MS,
  type EntryOptions,
  fillWindow,
  type QueryEntry,
  refillWindowInLane,
} from './query-window';
import { SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';
import type { Scheduler } from './thundering-herd';

const input: JsonValue = { orgId: 'o1' };
const rows: readonly Row[] = [{ id: 'p1', orgId: 'o1', likes: 0 }];

class PoolTimeout extends Error {
  readonly code = 'X_DB_TIMEOUT';
}

/** A definition whose read is driven from the test: one answer per call, in order. */
function entryWith(snapshot: () => Promise<SnapshotResult>, options?: EntryOptions): QueryEntry {
  const definition: LiveQueryDefinition = {
    name: 'liveFeed',
    entities: ['posts'],
    snapshot,
    visible: () => true,
    matcher: () => ({ entities: ['posts'], match: () => ({ patches: [], refill: false }) }),
  };
  return createEntry('liveFeed:1', definition, input, definition.matcher(input), options);
}

/**
 * The deadline, fired by the test rather than waited for. A timer this returns is armed by
 * `startRead` and disarmed by the read that settles first, so `fire === undefined` is itself the
 * assertion that a settled read did not leave one running.
 */
function fakeScheduler(): { schedule: Scheduler; fire: () => void; armed: () => boolean } {
  let pending: (() => void) | null = null;
  return {
    schedule: (fn) => {
      pending = fn;
      return (): void => {
        pending = null;
      };
    },
    fire: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
    armed: () => pending !== null,
  };
}

/** A read that never answers: the pool is gone and the query is neither resolving nor rejecting. */
const never = async (): Promise<SnapshotResult> => await new Promise<SnapshotResult>(() => {});

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

// A read that never settles used to pin `entry.reading` for the life of the process: every later
// cold subscriber joined a promise nothing would ever resolve, so one wedged snapshot took every
// future subscriber of that query id with it. The deadline frees the SLOT — it cannot cancel the
// read, and pretending otherwise would be a second, false promise.
describe('a shared read that never answers does not pin the window forever', () => {
  test('a later cold subscriber is not stuck behind it', async () => {
    const clock = fakeScheduler();
    let answer: SnapshotResult | null = null;
    const entry = entryWith(async () => (answer === null ? await never() : answer), {
      readDeadlineMs: 5_000,
      schedule: clock.schedule,
    });

    const wedged = fillWindow(entry);
    expect(entry.reading).not.toBeNull();
    expect(clock.armed()).toBe(true);

    clock.fire();
    await expect(wedged).rejects.toThrow(/did not answer/);

    // The slot is free, so the next subscriber issues its OWN read instead of joining the wedged
    // one — which is the whole of the fix.
    expect(entry.reading).toBeNull();
    answer = { rows, lsn: formatLsn(4) };
    await expect(fillWindow(entry)).resolves.toEqual({ rows, lsn: formatLsn(4) });
  }, 1_000);

  test('the window it was sent to fill is left STALE, exactly as a rejecting read leaves it', async () => {
    const clock = fakeScheduler();
    const entry = entryWith(never, { readDeadlineMs: 5_000, schedule: clock.schedule });
    entry.stale = true;

    const wedged = fillWindow(entry);
    // Cleared on the way in by the read that was going to answer it.
    expect(entry.stale).toBe(false);
    clock.fire();
    await expect(wedged).rejects.toThrow(/did not answer/);

    // Put back, or the gap repair happens once and never again — `readSnapshot`'s rule, and a
    // deadline is a read that did not answer by any other name.
    expect(entry.stale).toBe(true);
    expect(entry.rows).toEqual([]);
  }, 1_000);

  test('every caller already joined is told, not left waiting', async () => {
    const clock = fakeScheduler();
    const entry = entryWith(never, { readDeadlineMs: 5_000, schedule: clock.schedule });

    const leader = fillWindow(entry);
    const joiner = fillWindow(entry);
    // One read for both — the joiner did not issue its own, which is what makes being left behind
    // the leader's dead promise the defect it was.
    expect(entry.generation).toBe(1);

    // Subscribed BEFORE the deadline fires — every joiner rejects in the same turn, and a handler
    // attached a line later is an unhandled rejection for one microtask.
    const outcome = Promise.allSettled([leader, joiner]);
    clock.fire();
    const settled = await outcome;

    expect(settled.map((one) => one.status)).toEqual(['rejected', 'rejected']);
    for (const one of settled) {
      const reason: unknown = one.status === 'rejected' ? one.reason : null;
      // The CODE, not the message: `X_TIMEOUT` is what core classifies `retryable`, which is what
      // tells a caller this is worth asking for again.
      expect(isUltimateError(reason) ? reason.code : null).toBe('X_TIMEOUT');
    }
  }, 1_000);

  test('a read that settles first disarms its deadline', async () => {
    const clock = fakeScheduler();
    const entry = entryWith(async () => ({ rows, lsn: formatLsn(4) }), {
      readDeadlineMs: 5_000,
      schedule: clock.schedule,
    });

    await expect(fillWindow(entry)).resolves.toEqual({ rows, lsn: formatLsn(4) });
    // An armed timer per completed read is a leak that keeps the process alive.
    expect(clock.armed()).toBe(false);
    expect(entry.reading).toBeNull();
  }, 1_000);

  test('a read that answers AFTER its deadline does not clear a newer read’s slot', async () => {
    const clock = fakeScheduler();
    // A one-field holder, not a `let`: the only assignment is inside a callback, so control-flow
    // analysis narrows a `let` to `null` at the call site below and refuses to call it.
    const abandoned: { release: ((result: SnapshotResult) => void) | null } = { release: null };
    const entry = entryWith(
      async () =>
        await new Promise<SnapshotResult>((resolve) => {
          abandoned.release ??= resolve;
        }),
      { readDeadlineMs: 5_000, schedule: clock.schedule },
    );

    const wedged = fillWindow(entry);
    clock.fire();
    await expect(wedged).rejects.toThrow(/did not answer/);

    // A newer read takes the slot the deadline freed.
    const second = fillWindow(entry);
    const held = entry.reading;
    expect(held).not.toBeNull();
    expect(entry.generation).toBe(2);

    // The abandoned read finally answers. Identity, never presence: it must not clear the slot the
    // newer read holds, or every subscriber after it joins a promise nothing answers for.
    abandoned.release?.({ rows, lsn: formatLsn(1) });
    await Promise.resolve();
    await Promise.resolve();
    expect(entry.reading).toBe(held);

    abandoned.release = null;
    void second;
  }, 1_000);

  // The rule the deadline makes load-bearing rather than merely careful. It is NOT reachable
  // through the deadline itself — `done` hangs off the RACED promise, which settles once, so an
  // abandoned read never calls it a second time — and it is reachable through the forced path,
  // which is the one place two reads of one entry are in flight together.
  test('a read that settles after a newer one started does not clear the newer one’s slot', async () => {
    const clock = fakeScheduler();
    const gate: ((result: SnapshotResult) => void)[] = [];
    const entry = entryWith(
      async () =>
        await new Promise<SnapshotResult>((resolve) => {
          gate.push(resolve);
        }),
      { readDeadlineMs: 5_000, schedule: clock.schedule },
    );

    const older = fillWindow(entry);
    // The change stream skipped a sequence, so the next caller forces its own read rather than
    // joining one issued before the gap.
    entry.stale = true;
    const newer = fillWindow(entry);
    const held = entry.reading;
    expect(entry.generation).toBe(2);
    expect(held).not.toBeNull();

    gate[0]?.({ rows: [], lsn: '' });
    await older;
    // Identity, never presence: presence hands the newer read's joiners a slot the entry no longer
    // answers for, and every subscriber arriving after it issues a read that was already in flight.
    expect(entry.reading).toBe(held);

    gate[1]?.({ rows, lsn: formatLsn(4) });
    await newer;
    expect(entry.reading).toBeNull();
  }, 1_000);

  test('a deadline that cannot mean anything falls back to the default, never to "now"', () => {
    // `0` cannot mean both "immediately" and "never", so it means neither: a read that times out
    // on the turn it was issued is a live query that can never answer at all.
    for (const declared of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(entryWith(never, { readDeadlineMs: declared }).readDeadlineMs).toBe(
        DEFAULT_READ_DEADLINE_MS,
      );
    }
    expect(entryWith(never, { readDeadlineMs: 250 }).readDeadlineMs).toBe(250);
    expect(entryWith(never).readDeadlineMs).toBe(DEFAULT_READ_DEADLINE_MS);
  });

  test('the default deadline is a number, not an absent one', () => {
    expect(DEFAULT_READ_DEADLINE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_READ_DEADLINE_MS)).toBe(true);
  });
});
