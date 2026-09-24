// The bounded in-memory ISR store, on its own: eviction is by generation, never by the last mark.
import { describe, expect, test } from 'bun:test';
import { memoryIsrStore } from './render-isr-store';

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
