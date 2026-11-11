// `orderVersions`: write order out of rows that tie on `at` — the walk over before→after images,
// the counting columns left out of the match, and the deterministic fallback where no walk exists.

import { describe, expect, test } from 'bun:test';
import { type HistoryRecord, orderVersions } from './history-order';

const AT = new Date('2026-11-10T09:00:00.000Z');
const LATER = new Date('2026-11-10T09:00:01.000Z');

let serial = 0;
/** Ids descend against write order, so an id sort alone would read every tie backwards. */
const row = (
  op: string,
  before: HistoryRecord['before'],
  after: HistoryRecord['after'],
  at: Date = AT,
): HistoryRecord => {
  serial += 1;
  return {
    id: `id-${String(1000 - serial)}`,
    rowId: 'r1',
    op,
    at,
    actorId: null,
    requestId: null,
    before,
    after,
  };
};

const titles = (rows: ReturnType<typeof orderVersions>) =>
  rows.map((r) => `${r.version}:${r.op}:${String(r.after?.['title'] ?? '-')}`);

describe('orderVersions', () => {
  test('a tie is ordered by its before→after chain, A→B→A→C included', () => {
    const rows = [
      row('insert', null, { title: 'a' }),
      row('update', { title: 'a' }, { title: 'b' }),
      row('update', { title: 'b' }, { title: 'a' }),
      row('update', { title: 'a' }, { title: 'c' }),
      row('delete', { title: 'c' }, null),
      row('insert', null, { title: 'again' }),
    ];
    expect(titles(orderVersions([...rows].reverse()))).toEqual([
      '1:insert:a',
      '2:update:b',
      '3:update:a',
      '4:update:c',
      '5:delete:-',
      '6:insert:again',
    ]);
  });

  test('the chain outranks `at`: a transaction that began first and committed last reads last', () => {
    // `at` is the TRANSACTION's start (`now()`): T2 began at EARLIER, T1 at AT and committed
    // first, then T2 wrote B→C. By `at` alone B→C would precede A→B and the latest would be B.
    const EARLIER = new Date(AT.getTime() - 1_000);
    const rows = [
      row('insert', null, { title: 'a' }, new Date(AT.getTime() - 60_000)),
      row('update', { title: 'a' }, { title: 'b' }, AT),
      row('update', { title: 'b' }, { title: 'c' }, EARLIER),
    ];
    expect(titles(orderVersions(rows))).toEqual(['1:insert:a', '2:update:b', '3:update:c']);
  });

  test('a whole lifecycle starts at the insert, even when the delete carries the earlier `at`', () => {
    // T2 began first, T1 inserted and committed, then T2 deleted: every image balances, and the
    // delete's `at` is the earliest — the walk must still start at the insert's NULL `before`.
    const EARLIER = new Date(AT.getTime() - 1_000);
    const rows = [
      row('delete', { title: 'a' }, null, EARLIER),
      row('insert', null, { title: 'a' }),
    ];
    expect(orderVersions(rows).map((r) => `${r.version}:${r.op}`)).toEqual([
      '1:insert',
      '2:delete',
    ]);
  });

  test('no chain across rows (a purged prefix): by `at`, then within an instant', () => {
    const rows = [
      row('update', { title: 'q' }, { title: 'r' }, LATER),
      row('update', { title: 'x' }, { title: 'y' }),
    ];
    expect(titles(orderVersions(rows))).toEqual(['1:update:y', '2:update:r']);
  });

  test('a counting column is left out of the match: its change alone recorded nothing', () => {
    const rows = [
      row('insert', null, { title: 'a', likes: 0 }),
      row('update', { title: 'b', likes: 4 }, { title: 'c', likes: 4 }),
      row('update', { title: 'a', likes: 4 }, { title: 'b', likes: 4 }),
    ];
    expect(titles(orderVersions(rows, new Set(['likes'])))).toEqual([
      '1:insert:a',
      '2:update:b',
      '3:update:c',
    ]);
  });

  test('no walk (a purged prefix): insert, update, delete, then id — never a throw', () => {
    const rows = [
      row('delete', { title: 'z' }, null),
      row('update', { title: 'x' }, { title: 'y' }),
      row('update', { title: 'p' }, { title: 'q' }),
    ];
    expect(orderVersions(rows).map((r): unknown[] => [r.version, r.op, r.id])).toEqual([
      [1, 'update', rows[2]?.id],
      [2, 'update', rows[1]?.id],
      [3, 'delete', rows[0]?.id],
    ]);
  });

  test('no rows, no versions', () => {
    expect(orderVersions([])).toEqual([]);
  });

  test('an op named like an Object.prototype member ranks as an unknown op, never as a function', () => {
    // No chain links these two, so the rank decides: an unknown op ranks as an update, before the
    // delete. Off a plain object literal `constructor` was a function, its rank NaN, and the tie
    // fell through to the ids — which descend against write order, so the delete read first.
    const unknown = row('constructor', { title: 'q' }, { title: 'r' });
    const deleted = row('delete', { title: 's' }, null);
    expect(orderVersions([deleted, unknown]).map((r) => r.op)).toEqual(['constructor', 'delete']);
  });
});
