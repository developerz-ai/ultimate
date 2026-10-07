// `useRecords(type, { where, order })`: every record of one type the page store holds, as a list
// that grows when a channel's `records` frame adopts a new one (#680) — the channel-records
// counterpart of a live window, readable with no live query, no key list and no reach into
// `globalThis`. The key-list form beside it keeps its own rules (`use-record.test.ts`).

import { afterEach, describe, expect, test } from 'bun:test';
import { pageHarness, resetPage } from './hooks-fixture';
import { PROTOCOL_VERSION } from './sync-protocol';
import { useChannel } from './use-channel';
import { useRecord, useRecords } from './use-record';

afterEach(() => {
  resetPage();
});

const orgFeed = {
  name: 'org-feed',
  catchUp: 'orgFeedCatchUp',
  topic: (params: Readonly<Record<'orgId', string>>) => `org-feed.${params.orgId}`,
};

type Run = { readonly id: string; readonly state: string; readonly at: number };

describe('useRecords over a type', () => {
  test('a record a channel frame adopts reaches the list — the issue’s repro', () => {
    const { socket } = pageHarness();
    socket.open();
    using _channel = useChannel(orgFeed, { orgId: 'o1' });
    using runs = useRecords<Run>('runs', {});
    expect(runs()).toEqual({ status: 'ready', data: [] });

    socket.deliver({
      type: 'records',
      v: PROTOCOL_VERSION,
      channel: 'org-feed.o1',
      seq: 1,
      epoch: 'e1',
      adopt: { runs: { r2: { id: 'r2', state: 'queued', at: 2 } } },
    });
    expect(runs()).toEqual({ status: 'ready', data: [{ id: 'r2', state: 'queued', at: 2 }] });
  });

  test('ordered by key by default, by `order` when given, filtered by `where`', () => {
    const { page } = pageHarness();
    using byKey = useRecords<Run>('runs', {});
    using newest = useRecords<Run>('runs', {
      where: (run) => run.state !== 'done',
      order: (a, b) => b.at - a.at,
    });
    page.store.adopt('runs', {
      r2: { id: 'r2', state: 'queued', at: 1 },
      r1: { id: 'r1', state: 'done', at: 3 },
      r3: { id: 'r3', state: 'running', at: 2 },
    });
    page.store.adopt('lines', { l1: { id: 'l1' } });
    const ids = (answer: ReturnType<typeof byKey>): readonly string[] =>
      answer.status === 'ready' ? answer.data.map((run) => run.id) : [];
    expect(ids(byKey())).toEqual(['r1', 'r2', 'r3']);
    expect(ids(newest())).toEqual(['r3', 'r2']);

    page.store.merge('runs', 'r3', { state: 'done' });
    page.store.remove('runs', ['r2']);
    expect(ids(newest())).toEqual([]);
    expect(ids(byKey())).toEqual(['r1', 'r3']);
  });

  test('the rows are the store’s own objects, and an optimistic one shows before the server’s', () => {
    const { page } = pageHarness();
    using runs = useRecords<Run>('runs', {});
    using one = useRecord<Run>('runs', 'r1');
    page.store.adopt('runs', { r1: { id: 'r1', state: 'queued', at: 1 } });
    const list = runs();
    const single = one();
    expect(
      list.status === 'ready' && single.status === 'ready' && list.data[0] === single.data,
    ).toBe(true);

    page.store.push(
      'startRun:k1',
      (tx) => tx['runs']?.insert('r9', { id: 'r9', state: 'queued', at: 9 }),
      'server-wins',
    );
    expect(runs()).toMatchObject({ status: 'ready', data: [{ id: 'r1' }, { id: 'r9' }] });
  });

  // The answer is recomputed only when its own type moved: the same object back is what tells a
  // fine-grained renderer nothing changed.
  test('answers the same list until a record of its own type moves', () => {
    const { page } = pageHarness();
    using runs = useRecords<Run>('runs', {});
    const before = runs();
    expect(runs()).toBe(before);
    page.store.adopt('lines', { l1: { id: 'l1' } });
    expect(runs()).toBe(before);
    page.store.adopt('runs', { r1: { id: 'r1', state: 'queued', at: 1 } });
    expect(runs()).not.toBe(before);
  });

  test('a record it shows is not evicted when another holder of that key lets go', () => {
    const { page } = pageHarness();
    using runs = useRecords<Run>('runs', {});
    const one = useRecord<Run>('runs', 'r1');
    page.store.adopt('runs', { r1: { id: 'r1', state: 'queued', at: 1 } });
    one.release();
    expect(runs()).toMatchObject({ status: 'ready', data: [{ id: 'r1' }] });
  });

  test('a server render is pending and creates no page state', () => {
    resetPage();
    const runs = useRecords('runs', { where: () => true });
    expect(runs()).toEqual({ status: 'pending' });
    runs.release();
  });
});

// Spared for a whole-type reader is not kept forever: once the last type hold goes, a row no key
// holder holds is evicted as its own last release would have evicted it — and told to the page.
describe('the end of a type hold', () => {
  test('evicts what it spared, and only that', () => {
    const { page } = pageHarness();
    const runs = useRecords<Run>('runs', {});
    const spared = useRecord<Run>('runs', 'r1');
    const kept = useRecord<Run>('runs', 'r2');
    page.store.adopt('runs', {
      r1: { id: 'r1', state: 'queued', at: 1 },
      r2: { id: 'r2', state: 'queued', at: 2 },
      r3: { id: 'r3', state: 'queued', at: 3 },
    });
    spared.release();
    expect(page.store.peek('runs', 'r1')).toBeDefined();
    const told: string[] = [];
    page.store.subscribe((changed) => told.push(...changed));

    runs.release();
    expect(page.store.peek('runs', 'r1')).toBeUndefined();
    expect(told).toEqual(['runs:r1']);
    // A key still held stays, and a row nothing ever key-held was never the hold's to evict.
    expect(page.store.peek('runs', 'r2')).toBeDefined();
    expect(page.store.peek('runs', 'r3')).toBeDefined();
    kept.release();
    expect(page.store.peek('runs', 'r2')).toBeUndefined();
  });

  test('a second reader of the type keeps the spared row until it too lets go', () => {
    const { page } = pageHarness();
    const a = useRecords<Run>('runs', {});
    const b = useRecords<Run>('runs', { where: () => true });
    const one = useRecord<Run>('runs', 'r1');
    page.store.adopt('runs', { r1: { id: 'r1', state: 'queued', at: 1 } });
    one.release();
    a.release();
    expect(page.store.peek('runs', 'r1')).toBeDefined();
    b.release();
    expect(page.store.peek('runs', 'r1')).toBeUndefined();
  });

  test('a row held again by key before the hold ends is not evicted by it', () => {
    const { page } = pageHarness();
    const runs = useRecords<Run>('runs', {});
    const first = useRecord<Run>('runs', 'r1');
    page.store.adopt('runs', { r1: { id: 'r1', state: 'queued', at: 1 } });
    first.release();
    const again = useRecord<Run>('runs', 'r1');
    runs.release();
    expect(page.store.peek('runs', 'r1')).toBeDefined();
    again.release();
    expect(page.store.peek('runs', 'r1')).toBeUndefined();
  });

  test('a spared row the server removed and sent again is a new arrival, not the hold’s to evict', () => {
    const { page } = pageHarness();
    const runs = useRecords<Run>('runs', {});
    const one = useRecord<Run>('runs', 'r1');
    page.store.adopt('runs', { r1: { id: 'r1', state: 'queued', at: 1 } });
    one.release();
    page.store.remove('runs', ['r1']);
    page.store.adopt('runs', { r1: { id: 'r1', state: 'running', at: 1 } });
    runs.release();
    expect(page.store.peek('runs', 'r1')).toMatchObject({ state: 'running' });
  });
});
