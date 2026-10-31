// What bounds the rows channels adopt. A `records` frame's rows carry no reader hold, so until
// 29.3.1 nothing ever evicted them: a panel tab on a fleet feed kept every run it ever heard of,
// and leaving a run's channel left its events. Now each channel keeps what it adopted until it is
// dropped, and a per-type cap (least recently written, unheld) bounds one joined for hours.

import { afterEach, describe, expect, test } from 'bun:test';
import { ChannelBook } from './client-channels';
import { pageHarness, resetPage } from './hooks-fixture';
import { DEFAULT_MAX_ROWS_PER_TYPE, RecordStore } from './record-store';
import { type ChannelRecordsFrame, PROTOCOL_VERSION } from './sync-protocol';
import { useRecords } from './use-record';

afterEach(() => {
  resetPage();
});

const runs = {
  name: 'runs',
  catchUp: 'runsCatchUp',
  topic: (params: Readonly<Record<'scope', string>>) => `runs.${params.scope}`,
};

function bookOver(store: RecordStore): ChannelBook {
  return new ChannelBook({
    store,
    send: () => undefined,
    connected: () => true,
    catchUp: async () => undefined,
    report: () => undefined,
  });
}

const frame = (topic: string, seq: number, key: string): ChannelRecordsFrame => ({
  type: 'records',
  v: PROTOCOL_VERSION,
  channel: topic,
  seq,
  epoch: 'e1',
  adopt: { runs: { [key]: { id: key, seq } } },
});

describe('a channel joined for hours', () => {
  test('12 000 frames of distinct keys, nobody holding them, keep at most the cap', () => {
    const store = new RecordStore();
    const book = bookOver(store);
    book.hold(runs, { scope: 'fleet' });
    for (let seq = 1; seq <= 12_000; seq += 1) book.records(frame('runs.fleet', seq, `r${seq}`));
    expect(store.size).toBe(DEFAULT_MAX_ROWS_PER_TYPE);
    // The newest stay: the cap evicts the least recently written first.
    expect(store.peek('runs', 'r12000')).toBeDefined();
    expect(store.peek('runs', 'r2000')).toBeUndefined();
    expect(store.peek('runs', 'r2001')).toBeDefined();
  });

  // The cap is a backstop, not a view limit: a run page's whole-type reader shows one run's 2 000
  // log lines, and the default must leave every one of them where the person is reading.
  test('a whole-type reader of 2 000 rows of one type under the default cap loses none', () => {
    const { page } = pageHarness();
    using lines = useRecords('runs', {});
    const book = bookOver(page.store);
    book.hold(runs, { scope: 'r1' });
    for (let seq = 1; seq <= 2_000; seq += 1) book.records(frame('runs.r1', seq, `l${seq}`));
    const shown = lines();
    expect(shown.status === 'ready' ? shown.data.length : -1).toBe(2_000);
  });

  test('a whole-type reader does not exempt its type from the cap', () => {
    const { page } = pageHarness();
    using all = useRecords('runs', {});
    const book = bookOver(page.store);
    book.hold(runs, { scope: 'fleet' });
    const past = DEFAULT_MAX_ROWS_PER_TYPE + 500;
    for (let seq = 1; seq <= past; seq += 1) book.records(frame('runs.fleet', seq, `r${seq}`));
    const shown = all();
    expect(shown.status === 'ready' ? shown.data.length : -1).toBe(DEFAULT_MAX_ROWS_PER_TYPE);
  });

  test('a row a key reader holds, and one a pending write touched, are never the cap’s', () => {
    const { page } = pageHarness();
    const store = page.store;
    store.adopt('runs', { held: { id: 'held' }, written: { id: 'written' } });
    using held = useRecords('runs', ['held']);
    store.push('w1', (tx) => tx['runs']?.update('written', { state: 'mine' }), 'server-wins');
    const book = bookOver(store);
    book.hold(runs, { scope: 'fleet' });
    const past = DEFAULT_MAX_ROWS_PER_TYPE + 500;
    for (let seq = 1; seq <= past; seq += 1) book.records(frame('runs.fleet', seq, `r${seq}`));

    expect(held()).toMatchObject({ status: 'ready', data: [{ id: 'held' }] });
    expect(store.synced('runs', 'held')).toBeDefined();
    expect(store.synced('runs', 'written')).toBeDefined();
    expect(store.peek('runs', 'written')).toMatchObject({ state: 'mine' });
    expect(store.size).toBe(DEFAULT_MAX_ROWS_PER_TYPE);
  });

  test('a cap that is not a whole number ≥ 1 is refused; Infinity turns it off', () => {
    for (const bad of [Number.NaN, 0, -1, 2.5]) {
      expect(() => new RecordStore({ maxRowsPerType: bad })).toThrow(/maxRowsPerType/);
      expect(() => new RecordStore({ maxRowsByType: { runs: bad } })).toThrow(/maxRowsByType/);
    }
    // Past the default, in separate batches (each trims): Infinity keeps every row.
    const store = new RecordStore({ maxRowsPerType: Number.POSITIVE_INFINITY });
    const past = DEFAULT_MAX_ROWS_PER_TYPE + 500;
    for (let start = 0; start < past; start += 1_000) {
      const rows = Array.from({ length: Math.min(1_000, past - start) }, (_, n) => [
        `r${start + n}`,
        {},
      ]);
      store.adopt('runs', Object.fromEntries(rows));
    }
    expect(store.size).toBe(past);
  });

  test('a row written several times in one batch shields only itself, not older rows', () => {
    const store = new RecordStore({ maxRowsPerType: 2 });
    store.adopt('runs', { a: { id: 'a' } });
    store.adopt('runs', { b: { id: 'b' } });
    store.batch(() => {
      store.adopt('runs', { c: { id: 'c', v: 1 } });
      store.adopt('runs', { c: { id: 'c', v: 2 } });
      store.adopt('runs', { c: { id: 'c', v: 3 } });
    });
    expect(store.size).toBe(2);
  });

  test('the cap is the store’s option', () => {
    const store = new RecordStore({ maxRowsPerType: 10 });
    const book = bookOver(store);
    book.hold(runs, { scope: 'fleet' });
    for (let seq = 1; seq <= 50; seq += 1) book.records(frame('runs.fleet', seq, `r${seq}`));
    expect(store.size).toBe(10);
  });

  test('a type named in maxRowsByType takes its own cap; the rest keep maxRowsPerType', () => {
    const store = new RecordStore({ maxRowsPerType: 10, maxRowsByType: { logs: 30 } });
    for (let n = 1; n <= 50; n += 1) {
      store.adopt('runs', { [`r${n}`]: { id: `r${n}` } });
      store.adopt('logs', { [`l${n}`]: { id: `l${n}` } });
    }
    expect(store.all('runs')).toHaveLength(10);
    expect(store.all('logs')).toHaveLength(30);
  });
});

describe('dropping a channel', () => {
  test('evicts the rows it alone kept, and tells the page', () => {
    const store = new RecordStore();
    const book = bookOver(store);
    const membership = book.hold(runs, { scope: 'r1' });
    book.records(frame('runs.r1', 1, 'e1'));
    book.records(frame('runs.r1', 2, 'e2'));
    expect(store.size).toBe(2);
    const told: string[] = [];
    store.subscribe((changed) => told.push(...changed));

    membership.release();
    expect(store.size).toBe(0);
    expect(told.sort()).toEqual(['runs:e1', 'runs:e2']);
  });

  test('keeps a row a reader still holds, and one another joined channel adopted', () => {
    const { page } = pageHarness();
    const store = page.store;
    const book = bookOver(store);
    const one = book.hold(runs, { scope: 'r1' });
    book.hold(runs, { scope: 'fleet' });
    book.records(frame('runs.r1', 1, 'a'));
    book.records(frame('runs.r1', 2, 'b'));
    book.records(frame('runs.r1', 3, 'c'));
    book.records(frame('runs.fleet', 1, 'c'));
    using held = useRecords('runs', ['a']);

    one.release();
    expect(store.peek('runs', 'a')).toBeDefined();
    expect(store.peek('runs', 'b')).toBeUndefined();
    expect(store.peek('runs', 'c')).toBeDefined();

    // The reader leaving is now the last hold on `a`.
    held.release();
    expect(store.peek('runs', 'a')).toBeUndefined();
  });

  test('a row the server removed leaves the channel’s keep with it', () => {
    const store = new RecordStore();
    const book = bookOver(store);
    const membership = book.hold(runs, { scope: 'r1' });
    book.records(frame('runs.r1', 1, 'a'));
    book.records({ ...frame('runs.r1', 2, 'a'), adopt: {}, remove: { runs: ['a'] } });
    expect(store.size).toBe(0);
    // Adopted again over HTTP after it was removed: no channel keeps it, so the drop leaves it.
    store.adopt('runs', { a: { id: 'a' } });
    membership.release();
    expect(store.peek('runs', 'a')).toBeDefined();
  });
});
