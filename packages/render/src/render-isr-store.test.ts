// The bounded in-memory ISR store, on its own: least recently USED goes first (a read counts, a
// stale mark does not), and the bound is bytes as well as entries.
import { describe, expect, test } from 'bun:test';
import type { MemoryIsrStore } from './render-isr-store';
import { DEFAULT_ISR_MAX_BYTES, memoryIsrStore } from './render-isr-store';

const put = (store: MemoryIsrStore, path: string, html = path): void =>
  store.set({ path, html, hash: path, generatedAt: 0, ttlMs: null, stale: false });

describe('memoryIsrStore eviction order', () => {
  test('marking a page stale does not make it the newest — eviction is by generation', () => {
    // `markStale` re-inserted through `set`, so the Map's iteration order — which IS the eviction
    // order — put the STALEST page last. A tag bust therefore protected exactly the pages that
    // most needed regenerating and evicted the freshest one instead.
    const store = memoryIsrStore({ maxEntries: 2 });
    const entry = (path: string): void =>
      store.set({ path, html: path, hash: path, generatedAt: 0, ttlMs: null, stale: false });

    entry('/a');
    entry('/b');
    store.markStale('/a');
    entry('/c');

    expect(store.paths()).toEqual(['/b', '/c']);
  });

  test('an in-place mark answers false for a page the store never held', () => {
    expect(memoryIsrStore().markStale('/nothing')).toBe(false);
  });
});

describe('memoryIsrStore is least recently used', () => {
  test('a page that was read stays; the unread one goes', () => {
    // Eviction by generation order evicted a hot early page (the home page, read every request)
    // before cold pages generated after it.
    const store = memoryIsrStore({ maxEntries: 2 });
    put(store, '/hot');
    put(store, '/cold');
    expect(store.get('/hot')?.html).toBe('/hot');
    put(store, '/new');
    expect(store.paths()).toEqual(['/hot', '/new']);
  });

  test('a miss changes nothing', () => {
    const store = memoryIsrStore({ maxEntries: 2 });
    put(store, '/a');
    put(store, '/b');
    expect(store.get('/nothing')).toBeUndefined();
    put(store, '/c');
    expect(store.paths()).toEqual(['/b', '/c']);
  });
});

describe('memoryIsrStore is bounded in bytes', () => {
  test('defaults to 256 MiB', () => {
    expect(DEFAULT_ISR_MAX_BYTES).toBe(256 * 1024 * 1024);
  });

  test('pages are evicted, least recently used first, until the held html fits', () => {
    // A 1,000-entry cap of 7 MiB pages is 7 GiB resident; the count alone bounds nothing.
    const store = memoryIsrStore({ maxBytes: 10 });
    put(store, '/a', 'aaaa');
    put(store, '/b', 'bbbb');
    store.get('/a');
    put(store, '/c', 'cccc');
    expect(store.paths()).toEqual(['/a', '/c']);
  });

  test('re-setting a page replaces its bytes rather than adding to them', () => {
    const store = memoryIsrStore({ maxBytes: 8 });
    put(store, '/a', 'aaaa');
    put(store, '/a', 'AAAA');
    put(store, '/b', 'bbbb');
    expect(store.paths()).toEqual(['/a', '/b']);
  });

  test('a deleted page frees its bytes', () => {
    const store = memoryIsrStore({ maxBytes: 8 });
    put(store, '/a', 'aaaa');
    put(store, '/b', 'bbbb');
    store.delete('/a');
    put(store, '/c', 'cccc');
    expect(store.paths()).toEqual(['/b', '/c']);
  });

  test('a page larger than the whole cap is not kept, and evicts nothing', () => {
    const store = memoryIsrStore({ maxBytes: 8 });
    put(store, '/a', 'aaaa');
    put(store, '/huge', 'x'.repeat(9));
    expect(store.paths()).toEqual(['/a']);
  });

  test('a stale mark keeps the byte count', () => {
    const store = memoryIsrStore({ maxBytes: 8 });
    put(store, '/a', 'aaaa');
    store.markStale('/a');
    put(store, '/b', 'bbbb');
    expect(store.paths()).toEqual(['/a', '/b']);
  });

  test('refuses a cap that is not a whole number', () => {
    expect(() => memoryIsrStore({ maxBytes: Number.NaN })).toThrow(/maxBytes/);
    expect(() => memoryIsrStore({ maxBytes: 1.5 })).toThrow(/maxBytes/);
  });
});
