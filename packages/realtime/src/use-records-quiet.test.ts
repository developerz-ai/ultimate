// A read hook tells its readers only what moves THEM, and answers the same object when nothing
// did: a run page's alerts reader heard every fleet run (180 of 200 frames, none its own), and a
// poll that found the same rows handed out a new array each time — what a panel had to undo by
// hand (`stableRuns`, `sameData`, `throttle.ts`). `throttleMs` is the opt-in for a busy feed.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { AsyncState } from '@ultimat3/core/page';
import type { SignalFactory } from './client-contract';
import { flush, pageHarness, resetPage } from './hooks-fixture';
import { installRealtime } from './reactivity';
import { useQuery } from './use-query';
import { useRecord, useRecords } from './use-record';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetPage();
});

type Run = { readonly id: string; readonly by: string; readonly step?: number };

/** A page whose hooks count their notifications: one set, one re-render of every reader. */
function countingPage(): { page: ReturnType<typeof pageHarness>['page']; told: () => number } {
  const { page } = pageHarness();
  let told = 0;
  const signal: SignalFactory = <T>(initial: T) => {
    let value = initial;
    return [
      () => value,
      (next: T) => {
        value = next;
        told++;
      },
    ];
  };
  installRealtime({ signal });
  return { page, told: () => told };
}

/** An answer's rows, or `undefined` while pending or failed — what identity is asserted on. */
const dataOf = <R>(answer: AsyncState<R>): R | undefined =>
  answer.status === 'ready' || answer.status === 'refreshing' ? answer.data : undefined;

const ids = (answer: { status: string; data?: readonly Run[] }): readonly string[] =>
  (answer.data ?? []).map((run) => run.id);

describe('a whole-type reader with `where`', () => {
  test('is not told of a record it neither shows nor would show', () => {
    const { page, told } = countingPage();
    page.store.adopt('runs', { r1: { id: 'r1', by: 'me' }, r2: { id: 'r2', by: 'other' } });
    using mine = useRecords<Run>('runs', { where: (run) => run.by === 'me' });
    const first = mine();
    expect(ids(first)).toEqual(['r1']);

    page.store.merge('runs', 'r2', { step: 1 });
    page.store.adopt('runs', { r3: { id: 'r3', by: 'other' } });
    page.store.remove('runs', ['r3']);
    expect(told()).toBe(0);
    expect(mine()).toBe(first);
  });

  test('is told when a record joins it, moves in it, or leaves it', () => {
    const { page, told } = countingPage();
    page.store.adopt('runs', { r1: { id: 'r1', by: 'me' }, r2: { id: 'r2', by: 'other' } });
    using mine = useRecords<Run>('runs', { where: (run) => run.by === 'me' });
    mine();

    page.store.merge('runs', 'r2', { by: 'me' });
    expect(told()).toBe(1);
    expect(ids(mine())).toEqual(['r1', 'r2']);

    page.store.merge('runs', 'r1', { step: 2 });
    expect(told()).toBe(2);
    expect(dataOf(mine())?.[0]).toMatchObject({ id: 'r1', step: 2 });

    // r1 no longer matches: it was SHOWN, so its move is this reader's, though `where` now says no.
    page.store.merge('runs', 'r1', { by: 'other' });
    expect(told()).toBe(3);
    expect(ids(mine())).toEqual(['r2']);
  });

  test('a stale answer is told regardless — the next read recomputes it', () => {
    const { page, told } = countingPage();
    using mine = useRecords<Run>('runs', { where: (run) => run.by === 'me' });
    // Never read: there is no answer to compare against.
    page.store.adopt('runs', { r1: { id: 'r1', by: 'other' } });
    expect(told()).toBe(1);
    expect(ids(mine())).toEqual([]);
  });

  test('a `where` that throws is told (the read raises it) and never silences other readers', () => {
    const { page } = countingPage();
    page.store.adopt('runs', { r1: { id: 'r1', by: 'me' } });
    let fail = false;
    // The app's predicate failing on a row: a foreign error handed to the hook, not a verdict.
    const badRow = new TypeError('bad row');
    using picky = useRecords<Run>('runs', {
      where: (run) => {
        if (fail) throw badRow;
        return run.by === 'me';
      },
    });
    using all = useRecords<Run>('runs', {});
    picky();
    all();
    fail = true;
    page.store.adopt('runs', { r2: { id: 'r2', by: 'other' } });
    expect(ids(all())).toEqual(['r1', 'r2']);
    expect(() => picky()).toThrow(TypeError);
  });
});

describe('the same answer when nothing shown moved', () => {
  test('a refetch that answers the same rows hands back the same `data` array', async () => {
    const { page } = countingPage();
    const rows = { r1: { id: 'r1', by: 'me' }, r2: { id: 'r2', by: 'me' } };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: Object.values(rows), records: { runs: rows } }), {
        status: 200,
        headers: { 'x-ultimate-records': '1' },
      })) as unknown as typeof fetch;
    using list = useQuery<Run>({ name: 'listRuns', entity: 'runs' }, null);
    await flush();
    const first = list();
    expect(ids(first)).toEqual(['r1', 'r2']);

    list.refetch();
    const refreshing = list();
    expect(refreshing.status).toBe('refreshing');
    expect(dataOf(refreshing)).toBe(dataOf(first));
    await flush();
    const again = list();
    expect(again.status).toBe('ready');
    expect(dataOf(again)).toBe(dataOf(first));
    // Read twice with nothing between: one object, not two equal ones.
    expect(list()).toBe(again);

    page.store.merge('runs', 'r1', { step: 1 });
    expect(list()).not.toBe(again);
  });

  test('useRecord answers the same object until its row moves', () => {
    const { page } = countingPage();
    page.store.adopt('runs', { r1: { id: 'r1', by: 'me' } });
    using one = useRecord<Run>('runs', 'r1');
    const before = one();
    expect(one()).toBe(before);
    page.store.merge('runs', 'r1', { step: 1 });
    expect(one()).not.toBe(before);
    expect(one()).toEqual({ status: 'ready', data: { id: 'r1', by: 'me', step: 1 } });
  });

  test('a key list keeps its answer across reads and renews it when a row moves', () => {
    const { page } = countingPage();
    page.store.adopt('runs', { r1: { id: 'r1', by: 'me' }, r2: { id: 'r2', by: 'me' } });
    using pair = useRecords<Run>('runs', ['r1', 'r2']);
    const before = pair();
    expect(pair()).toBe(before);
    page.store.merge('runs', 'r1', { step: 1 });
    const after = pair();
    expect(after).not.toBe(before);
    // The unmoved row is still the store's own object.
    expect(dataOf(after)?.[1]).toBe(dataOf(before)?.[1]);
  });
});

/** A hand-driven timer: `advance(ms)` runs what is due. */
function manualTimers() {
  let now = 0;
  const due: { at: number; fn: () => void }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn };
      due.push(timer);
      return () => {
        const at = due.indexOf(timer);
        if (at >= 0) due.splice(at, 1);
      };
    },
    advance(ms: number): void {
      now += ms;
      for (const timer of due.filter((one) => one.at <= now)) {
        due.splice(due.indexOf(timer), 1);
        timer.fn();
      }
    },
    pending: () => due.length,
  };
}

describe('`throttleMs`', () => {
  test('the first change at once, a burst as one at the end of the period, the last landing', () => {
    const { page, told } = countingPage();
    const timers = manualTimers();
    using runs = useRecords<Run>('runs', { throttleMs: 1_000, schedule: timers.schedule });
    runs();
    page.store.adopt('runs', { r1: { id: 'r1', by: 'me' } });
    expect(told()).toBe(1);
    for (let step = 1; step <= 9; step++) page.store.merge('runs', 'r1', { step });
    expect(told()).toBe(1);
    timers.advance(1_000);
    expect(told()).toBe(2);
    expect(dataOf(runs())?.[0]).toMatchObject({ step: 9 });
    // A quiet period owes nothing; the next lone change is told at once again.
    timers.advance(1_000);
    expect(told()).toBe(2);
    page.store.merge('runs', 'r1', { step: 10 });
    expect(told()).toBe(3);
  });

  test('release drops an owed notification and its timer', () => {
    const { page, told } = countingPage();
    const timers = manualTimers();
    const runs = useRecords<Run>('runs', { throttleMs: 500, schedule: timers.schedule });
    runs();
    page.store.adopt('runs', { r1: { id: 'r1', by: 'me' } });
    page.store.merge('runs', 'r1', { step: 1 });
    runs.release();
    expect(timers.pending()).toBe(0);
    timers.advance(500);
    expect(told()).toBe(1);
  });

  test('a non-finite or fractional period is refused where the hook is built', () => {
    countingPage();
    for (const throttleMs of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, -1]) {
      try {
        useRecords<Run>('runs', { throttleMs });
        expect.unreachable(`throttleMs ${throttleMs} was accepted`);
      } catch (error) {
        expect(isUltimateError(error) && error.code).toBe('X_INVARIANT');
      }
    }
  });
});
