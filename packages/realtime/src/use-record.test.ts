// `useRecord`: one record out of the page store, as an `AsyncState` — pending before it arrives,
// ready once it has, moved by ANY write to it, released by its holder. And the two rules about
// where it runs: a server render answers pending and touches no page state; a browser bundle that
// never installed realtime is refused by name.

import { afterEach, describe, expect, test } from 'bun:test';
import { pageClient, UltimateError } from '@ultimat3/core';
import { pageHarness, resetPage } from './hooks-fixture';
import { peekPageRealtime } from './page-store';
import { useRecord, useRecords } from './use-record';

afterEach(() => {
  resetPage();
});

describe('useRecord', () => {
  test('pending before the record is loaded, then the record once an HTTP answer adopts it', () => {
    const { page } = pageHarness();
    const post = useRecord('posts', 'p1');
    expect(post()).toEqual({ status: 'pending' });

    // What core's transport does with an answer's records: the page store is its sink.
    pageClient().store?.adopt('posts', { p1: { id: 'p1', title: 'hello' } });
    expect(post()).toEqual({ status: 'ready', data: { id: 'p1', title: 'hello' } });
    expect(page.store.peek('posts', 'p1')).toEqual({ id: 'p1', title: 'hello' });
  });

  test('two holders see the SAME object, and one write moves both', () => {
    const { page } = pageHarness();
    const a = useRecord('posts', 'p1');
    const b = useRecord('posts', 'p1');
    page.store.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    const first = a();
    const second = b();
    expect(
      first.status === 'ready' && second.status === 'ready' && first.data === second.data,
    ).toBe(true);
    page.store.merge('posts', 'p1', { likes: 2 });
    expect(b()).toEqual({ status: 'ready', data: { id: 'p1', likes: 2 } });
  });

  test('a record the server removed is a settled `undefined`, never a skeleton forever', () => {
    const { page } = pageHarness();
    const post = useRecord('posts', 'p1');
    page.store.adopt('posts', { p1: { id: 'p1' } });
    page.store.remove('posts', ['p1']);
    expect(post()).toEqual({ status: 'ready', data: undefined });
  });

  test('releasing the last holder evicts the record; releasing twice is a no-op', () => {
    const { page } = pageHarness();
    const a = useRecord('posts', 'p1');
    const b = useRecord('posts', 'p1');
    page.store.adopt('posts', { p1: { id: 'p1' } });
    a.release();
    a.release();
    expect(page.store.peek('posts', 'p1')).toBeDefined();
    b.release();
    expect(page.store.peek('posts', 'p1')).toBeUndefined();
  });

  test('a server render answers pending and creates no page state at all', () => {
    resetPage();
    const post = useRecord('posts', 'p1');
    expect(post()).toEqual({ status: 'pending' });
    expect(peekPageRealtime()).toBeUndefined();
    expect(pageClient().store).toBeUndefined();
  });

  test('useRecords on a server render is pending, holds nothing, and releases without a page', () => {
    resetPage();
    const posts = useRecords('posts', ['p1', 'p2']);
    expect(posts()).toEqual({ status: 'pending' });
    posts.release();
    expect(peekPageRealtime()).toBeUndefined();
  });

  test('in a browser bundle that never installed realtime it is X_REALTIME_UNINSTALLED', () => {
    resetPage();
    const host = globalThis as { document?: unknown; window?: unknown };
    host.document = {};
    host.window = {};
    try {
      expect(() => useRecord('posts', 'p1')).toThrow(UltimateError);
      try {
        useRecord('posts', 'p1');
      } catch (error) {
        expect(error instanceof UltimateError && error.code).toBe('X_REALTIME_UNINSTALLED');
      }
    } finally {
      delete host.document;
      delete host.window;
    }
  });
});

describe('useRecords', () => {
  test('pending until one arrives, then the present ones in KEY order, the same objects', () => {
    const { page } = pageHarness();
    const both = useRecords('posts', ['p2', 'p1']);
    const one = useRecord('posts', 'p1');
    expect(both()).toEqual({ status: 'pending' });
    page.store.adopt('posts', { p1: { id: 'p1' }, p2: { id: 'p2' } });
    const answer = both();
    expect(answer).toEqual({ status: 'ready', data: [{ id: 'p2' }, { id: 'p1' }] });
    const single = one();
    expect(
      answer.status === 'ready' && single.status === 'ready' && answer.data[1] === single.data,
    ).toBe(true);
    page.store.remove('posts', ['p2']);
    expect(both()).toEqual({ status: 'ready', data: [{ id: 'p1' }] });
  });

  test('release lets go of every key it held', () => {
    const { page } = pageHarness();
    const both = useRecords('posts', ['p1', 'p2']);
    page.store.adopt('posts', { p1: { id: 'p1' }, p2: { id: 'p2' } });
    both.release();
    expect(page.store.peek('posts', 'p1')).toBeUndefined();
  });
});
