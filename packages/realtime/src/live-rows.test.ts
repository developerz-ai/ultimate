// The window's own rules, without a socket: order is the registration's, values are the store's,
// a `delete` costs this window the row and nobody else, and a closed window holds nothing.

import { describe, expect, test } from 'bun:test';
import type { Row } from '@ultimat3/core';
import { type Registration, RowWindows, unnamedType } from './live-rows';
import { RecordStore } from './record-store';

function registration(name: string): Registration & { readonly seen: number[] } {
  const seen: number[] = [];
  return {
    sid: `sid-${name}`,
    name,
    input: null,
    type: unnamedType(name),
    ids: [],
    cursor: null,
    state: 'loading',
    error: undefined,
    notify: () => {
      seen.push(seen.length);
    },
    seen,
  };
}

describe('RowWindows', () => {
  test('two windows over one entity render the same object, and one patch moves both', () => {
    const map = new RecordStore();
    const windows = new RowWindows(map);
    const feed = registration('liveFeed');
    const pinned = registration('livePinned');
    windows.open(feed);
    windows.open(pinned);

    windows.snapshot(feed, 'posts', [
      { id: 'p1', likes: 1 },
      { id: 'p2', likes: 0 },
    ]);
    windows.snapshot(pinned, 'posts', [{ id: 'p1', likes: 1 }]);
    expect(windows.rows(feed)[0]).toBe(windows.rows(pinned)[0] as Row);

    windows.patch(feed, [{ op: 'update', id: 'p1', row: { likes: 2 }, lsn: 'a' }]);
    expect(windows.rows(pinned)[0]?.['likes']).toBe(2);
    // The other window heard about it exactly once, and only because it holds that row.
    expect(pinned.seen).toHaveLength(2);
  });

  test('a window is not told about a row it does not hold', () => {
    const map = new RecordStore();
    const windows = new RowWindows(map);
    const feed = registration('liveFeed');
    const pinned = registration('livePinned');
    windows.open(feed);
    windows.open(pinned);

    windows.snapshot(feed, 'posts', [{ id: 'p1', likes: 1 }]);
    windows.snapshot(pinned, 'posts', [{ id: 'p2', likes: 1 }]);
    const before = pinned.seen.length;

    windows.patch(feed, [{ op: 'update', id: 'p1', row: { likes: 9 }, lsn: 'a' }]);
    expect(pinned.seen).toHaveLength(before);
  });

  test('a unnamed type shares nothing: the same id in two unnamed windows is two rows', () => {
    const map = new RecordStore();
    const windows = new RowWindows(map);
    const feed = registration('liveFeed');
    const pinned = registration('livePinned');
    windows.open(feed);
    windows.open(pinned);

    windows.snapshot(feed, null, [{ id: 'p1', likes: 1 }]);
    windows.snapshot(pinned, null, [{ id: 'p1', likes: 7 }]);

    expect(windows.rows(feed)[0]?.['likes']).toBe(1);
    expect(windows.rows(pinned)[0]?.['likes']).toBe(7);
  });

  test('the first snapshot upgrades a unnamed type to the entity the server named', () => {
    const map = new RecordStore();
    const windows = new RowWindows(map);
    const feed = registration('liveFeed');
    windows.open(feed);

    windows.patch(feed, [{ op: 'insert', id: 'p1', row: { id: 'p1', likes: 1 }, lsn: 'a' }]);
    expect(feed.type).toBe(unnamedType('liveFeed'));

    windows.snapshot(feed, 'posts', [{ id: 'p1', likes: 1 }]);
    expect(feed.type).toBe('posts');
    // The unnamed type was released with the old window: nothing is left under it.
    expect(map.size).toBe(1);
  });

  test('a delete costs this window the row; a window still holding it keeps it', () => {
    const map = new RecordStore();
    const windows = new RowWindows(map);
    const feed = registration('liveFeed');
    const pinned = registration('livePinned');
    windows.open(feed);
    windows.open(pinned);
    windows.snapshot(feed, 'posts', [{ id: 'p1', likes: 1 }]);
    windows.snapshot(pinned, 'posts', [{ id: 'p1', likes: 1 }]);

    windows.patch(feed, [{ op: 'delete', id: 'p1', row: null, lsn: 'a' }]);
    expect(windows.rows(feed)).toEqual([]);
    expect(windows.rows(pinned)).toHaveLength(1);

    windows.patch(pinned, [{ op: 'delete', id: 'p1', row: null, lsn: 'b' }]);
    expect(map.size).toBe(0); // the last holder left, so the row is not retained forever
  });

  test('an insert with an index lands at that position, and one already held keeps its own', () => {
    const map = new RecordStore();
    const windows = new RowWindows(map);
    const feed = registration('liveFeed');
    windows.open(feed);
    windows.snapshot(feed, 'posts', [
      { id: 'p1', likes: 1 },
      { id: 'p2', likes: 2 },
    ]);

    windows.patch(feed, [
      { op: 'insert', id: 'p0', row: { id: 'p0', likes: 0 }, lsn: 'a', index: 0 },
      { op: 'update', id: 'p2', row: { likes: 5 }, lsn: 'a', index: 0 },
    ]);

    expect(windows.rows(feed).map((row) => row['id'])).toEqual(['p0', 'p1', 'p2']);
  });

  test('closing releases every row it held — an unmounted component is not a leak', () => {
    const map = new RecordStore();
    const windows = new RowWindows(map);
    const feed = registration('liveFeed');
    const close = windows.open(feed);
    windows.snapshot(feed, 'posts', [{ id: 'p1', likes: 1 }]);
    expect(map.size).toBe(1);

    close();
    expect(map.size).toBe(0);
    expect(windows.rows(feed)).toEqual([]);

    // And it stops listening: a later write reaches nobody.
    const seen = feed.seen.length;
    map.retain('posts', 'p1');
    map.merge('posts', 'p1', { likes: 3 });
    expect(feed.seen).toHaveLength(seen);
  });

  test('a re-snapshot replaces the window without dropping a row it keeps', () => {
    const map = new RecordStore();
    const windows = new RowWindows(map);
    const feed = registration('liveFeed');
    windows.open(feed);
    windows.snapshot(feed, 'posts', [
      { id: 'p1', likes: 1 },
      { id: 'p2', likes: 2 },
    ]);
    windows.snapshot(feed, 'posts', [{ id: 'p2', likes: 3 }]);

    expect(windows.rows(feed)).toEqual([{ id: 'p2', likes: 3 }]);
    expect(map.size).toBe(1);
  });
});

describe('RowWindows — keyed by the server', () => {
  test('a snapshot with keys holds records under them; a keyed patch folds into the same record', () => {
    const store = new RecordStore();
    const windows = new RowWindows(store);
    const feed = registration('liveLikes');
    windows.open(feed);
    windows.snapshot(feed, 'likes', [{ id: 'row-1', n: 1 }], ['p1:u1']);
    expect(store.peek('likes', 'p1:u1')).toEqual({ id: 'row-1', n: 1 });
    expect(store.peek('likes', 'row-1')).toBeUndefined();

    windows.patch(feed, [{ op: 'update', id: 'row-1', key: 'p1:u1', row: { n: 2 }, lsn: 'a' }]);
    expect(windows.rows(feed)).toEqual([{ id: 'row-1', n: 2 }]);
  });
});
