// `useRecordChanges`: told what moved, per type, and holding nothing — so a row no other reader
// holds is still evicted, a type nobody else holds is not pinned, and a server render is inert.

import { afterEach, describe, expect, test } from 'bun:test';
import { pageHarness, resetPage } from './hooks-fixture';
import { useRecord } from './use-record';
import { type RecordChanges, useRecordChanges } from './use-record-changes';

afterEach(() => {
  resetPage();
});

const plain = (changes: RecordChanges): Record<string, readonly string[]> =>
  Object.fromEntries(changes);

describe('useRecordChanges', () => {
  test('one call per store update, grouped by type, only for the watched types', () => {
    const { page } = pageHarness();
    const seen: Record<string, readonly string[]>[] = [];
    useRecordChanges(['posts', 'runs'], (changes) => seen.push(plain(changes)));

    page.store.batch(() => {
      page.store.adopt('posts', { p1: { id: 'p1' }, p2: { id: 'p2' } });
      page.store.adopt('runs', { r1: { id: 'r1' } });
      page.store.adopt('users', { u1: { id: 'u1' } });
    });
    page.store.adopt('users', { u2: { id: 'u2' } });

    expect(seen).toEqual([{ posts: ['p1', 'p2'], runs: ['r1'] }]);
  });

  test('a removal is a change too', () => {
    const { page } = pageHarness();
    page.store.adopt('posts', { p1: { id: 'p1' } });
    const seen: Record<string, readonly string[]>[] = [];
    useRecordChanges(['posts'], (changes) => seen.push(plain(changes)));
    page.store.remove('posts', ['p1']);
    expect(seen).toEqual([{ posts: ['p1'] }]);
  });

  test('holds nothing: the last real holder leaving still evicts the row', () => {
    const { page } = pageHarness();
    useRecordChanges(['posts'], () => undefined);
    const post = useRecord('posts', 'p1');
    page.store.adopt('posts', { p1: { id: 'p1' } });
    post.release();
    expect(page.store.peek('posts', 'p1')).toBeUndefined();
  });

  test('on a server render it subscribes to nothing, and its release is a no-op', () => {
    resetPage();
    const handle = useRecordChanges(['posts'], () => undefined);
    handle();
    handle.release();
    handle[Symbol.dispose]();
  });

  test('released, it hears nothing more; releasing twice is a no-op', () => {
    const { page } = pageHarness();
    const seen: unknown[] = [];
    const handle = useRecordChanges(['posts'], (changes) => seen.push(changes));
    handle.release();
    handle();
    page.store.adopt('posts', { p1: { id: 'p1' } });
    expect(seen).toEqual([]);
  });
});
