// BOUNDED is the whole point. A scrape of ten thousand pages that kept every console line and
// every request holds the run's entire browsing history in the worker's heap, and the incident is
// an OOM two hours in rather than a scraper bug.

import { describe, expect, test } from 'bun:test';
import type { NetworkEntry } from './rings';
import {
  createRing,
  DEFAULT_RING_CAPACITY,
  MAX_PAGE_ERROR_CHARS,
  pageErrorEntry,
  RESOURCE_TYPES,
} from './rings';

describe('unit · createRing', () => {
  test('it keeps the NEWEST entries and counts what it dropped', () => {
    // Newest, because the lines an author reads after a failure are the ones nearest to it — and
    // `dropped` is the honest "you are not seeing it all", which a silent truncation is not.
    const ring = createRing<number>(3);
    for (const value of [1, 2, 3, 4, 5]) ring.push(value);
    expect(ring.entries()).toEqual([3, 4, 5]);
    expect(ring.dropped).toBe(2);
    expect(ring.capacity).toBe(3);
  });

  test('under capacity nothing is dropped', () => {
    const ring = createRing<number>(3);
    ring.push(1);
    expect(ring.entries()).toEqual([1]);
    expect(ring.dropped).toBe(0);
  });

  test('entries() is a COPY — a caller holding the ring`s array would watch it mutate', () => {
    const ring = createRing<number>(3);
    ring.push(1);
    const snapshot = ring.entries();
    ring.push(2);
    expect(snapshot).toEqual([1]);
    expect(ring.entries()).toEqual([1, 2]);
  });

  test('clear() empties the ring AND resets the drop count', () => {
    // A `dropped` that survived a clear would report the previous page's losses against this one.
    const ring = createRing<NetworkEntry>(1);
    ring.push({ method: 'GET', url: 'https://shop.test/a', resourceType: 'document', at: 1 });
    ring.push({ method: 'GET', url: 'https://shop.test/b', resourceType: 'document', at: 2 });
    expect(ring.dropped).toBe(1);

    ring.clear();

    expect(ring.entries()).toEqual([]);
    expect(ring.dropped).toBe(0);
    // Still usable, and still bounded, after the clear.
    ring.push({ method: 'GET', url: 'https://shop.test/c', resourceType: 'document', at: 3 });
    ring.push({ method: 'GET', url: 'https://shop.test/d', resourceType: 'document', at: 4 });
    expect(ring.entries().map((entry) => entry.url)).toEqual(['https://shop.test/d']);
    expect(ring.dropped).toBe(1);
  });

  test('the default capacity is a bound, not unlimited', () => {
    const ring = createRing<number>();
    expect(ring.capacity).toBe(DEFAULT_RING_CAPACITY);
    for (let index = 0; index <= DEFAULT_RING_CAPACITY; index += 1) ring.push(index);
    expect(ring.entries()).toHaveLength(DEFAULT_RING_CAPACITY);
    expect(ring.dropped).toBe(1);
  });
});

describe('unit · pageErrorEntry', () => {
  test('a stack SURVIVES — it is the field that says which island threw', () => {
    const entry = pageErrorEntry({
      message: 'boom',
      stack: 'Error: boom\n    at Counter (/app/islands/counter.tsx:12:9)',
      at: 7,
    });
    expect(entry.message).toBe('boom');
    expect(entry.stack).toContain('islands/counter.tsx:12:9');
    expect(entry.at).toBe(7);
  });

  test('a huge stack is truncated to the cap, marked, and never held whole', () => {
    // The ring bounds the COUNT; one `Maximum call stack size exceeded` is thousands of frames,
    // and 200 of those retained per page is the same OOM the ring exists to prevent.
    const entry = pageErrorEntry({
      message: 'x'.repeat(MAX_PAGE_ERROR_CHARS + 500),
      stack: `${'at frame\n'.repeat(MAX_PAGE_ERROR_CHARS)}`,
      at: 1,
    });
    expect(entry.stack?.length).toBe(MAX_PAGE_ERROR_CHARS);
    expect(entry.stack?.endsWith('…')).toBe(true);
    expect(entry.message.length).toBe(MAX_PAGE_ERROR_CHARS);
    expect(entry.message.endsWith('…')).toBe(true);
  });

  test('a stack exactly at the cap is kept whole — the marker means truncated, always', () => {
    const entry = pageErrorEntry({ message: '', stack: 'a'.repeat(MAX_PAGE_ERROR_CHARS), at: 1 });
    expect(entry.stack).toBe('a'.repeat(MAX_PAGE_ERROR_CHARS));
  });

  test('no stack and an EMPTY stack are both absent — a blank stack reads as "no origin"', () => {
    expect(pageErrorEntry({ message: 'boom', at: 1 }).stack).toBeUndefined();
    expect(pageErrorEntry({ message: 'boom', stack: '', at: 1 }).stack).toBeUndefined();
    expect(Object.hasOwn(pageErrorEntry({ message: 'boom', at: 1 }), 'stack')).toBe(false);
  });
});

describe('unit · RESOURCE_TYPES', () => {
  test('"other" is in the list, because it is what an unknown type maps onto', () => {
    expect(RESOURCE_TYPES).toContain('other');
    expect(RESOURCE_TYPES).toContain('document');
    expect(new Set(RESOURCE_TYPES).size).toBe(RESOURCE_TYPES.length);
  });
});
