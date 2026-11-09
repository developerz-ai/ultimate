// The shared ISR store over a disk (plan 101 slice 14 P3): two replicas read one page, a bust on
// either fences a render that began before it — including one whose check passed just before the
// bump landed (write, then verify) — and the disk stays bounded across both.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CacheTag } from '@ultimat3/cache';
import { isolateGraph, resetGraph, tag } from '@ultimat3/cache';
import type { Page } from '@ultimat3/core';
import { UltimateError } from '@ultimat3/core';
import { clearRoutes, describePages } from './registry';
import { isrController } from './render-isr';
import { isrKeyIn, isrRouteWith } from './render-isr-fixture';
import type { IsrEntry, IsrStore } from './render-isr-store';
import type { IsrDisk, IsrDiskEntry } from './render-isr-store-storage';
import { storageIsrStore } from './render-isr-store-storage';

/** One bucket, as every replica sees it. `beforePut` lets a test land a bust mid-write. */
function memoryDisk() {
  const objects = new Map<string, { bytes: Uint8Array; at: number }>();
  let clock = 0;
  const hooks: { beforePut?: ((key: string) => Promise<void>) | undefined } = {};
  const disk: IsrDisk = {
    async put(key, body) {
      await hooks.beforePut?.(key);
      clock += 1;
      objects.set(key, { bytes: body, at: clock });
    },
    async get(key) {
      const held = objects.get(key);
      if (held === undefined) {
        throw new UltimateError({
          code: 'X_STORAGE_NOT_FOUND',
          cause: `no object at ${key}`,
          fix: 'none — a test double',
        });
      }
      return { bytes: held.bytes };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(options): Promise<Page<IsrDiskEntry>> {
      const rows = [...objects]
        .filter(([key]) => key.startsWith(options?.prefix ?? ''))
        .map(([key, held]) => ({
          key,
          size: held.bytes.byteLength,
          lastModified: new Date(held.at),
        }));
      // Two pages, so the store's cursor loop is exercised.
      const from = Number(options?.cursor ?? 0);
      const next = from + 2 < rows.length ? String(from + 2) : null;
      const page = rows.slice(from, from + 2);
      return next === null
        ? { rows: page, nextCursor: null, hasMore: false }
        : { rows: page, nextCursor: next, hasMore: true };
    },
  };
  return { disk, objects, hooks };
}

const entry = (path: string, html = `<p>${path}</p>`): IsrEntry => ({
  path,
  html,
  hash: 'h',
  generatedAt: 0,
  ttlMs: null,
  stale: false,
});

describe('storageIsrStore', () => {
  test('two stores over one disk share an entry, under any path a key can spell', async () => {
    const { disk } = memoryDisk();
    const a = storageIsrStore({ disk });
    const b = storageIsrStore({ disk });
    const path = '/precios-espa%C3%B1a?page=2&__x_locale=es';
    await a.set(entry(path));
    expect((await b.get(path))?.html).toBe(`<p>${path}</p>`);
    expect(await b.paths()).toEqual([path]);
    expect(await b.markStale(path)).toBe(true);
    expect((await a.get(path))?.stale).toBe(true);
    await b.delete(path);
    expect(await a.get(path)).toBeUndefined();
    expect(await a.markStale(path)).toBe(false);
  });

  test("a stored object that is not this key's entry is a miss, never a cast", async () => {
    const { disk, objects } = memoryDisk();
    const store = storageIsrStore({ disk });
    await store.set(entry('/a'));
    const [key] = [...objects.keys()];
    objects.set(key ?? '', { bytes: new TextEncoder().encode('{"path":"/b"}'), at: 99 });
    expect(await store.get('/a')).toBeUndefined();
  });

  test('the generation fence refuses a write whose reading another replica moved', async () => {
    const { disk } = memoryDisk();
    const writer = storageIsrStore({ disk });
    const purger = storageIsrStore({ disk });
    const sampled = await writer.tagFence?.sample(['post']);
    await purger.tagFence?.bump(['post']);
    expect(await writer.tagFence?.setIfCurrent(entry('/a'), ['post'], sampled ?? '')).toBe(false);
    expect(await purger.get('/a')).toBeUndefined();
  });

  test('a bump that lands between the check and the write takes the page down again', async () => {
    const { disk, hooks } = memoryDisk();
    const writer = storageIsrStore({ disk });
    const purger = storageIsrStore({ disk });
    const sampled = (await writer.tagFence?.sample(['post'])) ?? '';
    hooks.beforePut = async (key) => {
      if (!key.includes('/page/')) return;
      hooks.beforePut = undefined;
      await purger.tagFence?.bump(['post']);
    };
    expect(await writer.tagFence?.setIfCurrent(entry('/a'), ['post'], sampled)).toBe(false);
    expect(await purger.get('/a')).toBeUndefined();
  });

  test('a bump never writes a value an earlier reading held, so a late one cannot revive it', async () => {
    const { disk } = memoryDisk();
    let n = 0;
    const token = (): string => {
      n += 1;
      return `t${n}`;
    };
    const store = storageIsrStore({ disk, token });
    const first = await store.tagFence?.sample(['post']);
    await store.tagFence?.bump(['post']);
    const second = await store.tagFence?.sample(['post']);
    await store.tagFence?.bump(['post']);
    expect(new Set([first, second, await store.tagFence?.sample(['post'])]).size).toBe(3);
  });

  test('bounded in entries across replicas: the oldest write goes first', async () => {
    const { disk } = memoryDisk();
    const a = storageIsrStore({ disk, maxEntries: 2, sweepEvery: 1 });
    const b = storageIsrStore({ disk, maxEntries: 2, sweepEvery: 1 });
    await a.set(entry('/1'));
    await b.set(entry('/2'));
    await a.set(entry('/3'));
    expect(await b.paths()).toEqual(['/2', '/3']);
  });

  test('bounded in bytes, and a page over the whole cap is not kept', async () => {
    const { disk } = memoryDisk();
    const store = storageIsrStore({ disk, maxBytes: 400, sweepEvery: 1 });
    await store.set(entry('/a', 'a'.repeat(150)));
    await store.set(entry('/b', 'b'.repeat(150)));
    expect(await store.paths()).toEqual(['/b']);
    await store.set(entry('/huge', 'x'.repeat(401)));
    expect(await store.paths()).toEqual(['/b']);
  });

  test('admits by the bytes it writes, the same bytes the sweep counts', async () => {
    // Admitted on `html.length` and swept on the object's size, a page under the cap by the one
    // measure and over it by the other was written and then swept out — with the page before it.
    const { disk } = memoryDisk();
    const store = storageIsrStore({ disk, maxBytes: 400, sweepEvery: 1 });
    await store.set(entry('/a', 'a'));
    await store.set(entry('/b', 'b'.repeat(390)));
    expect(await store.paths()).toEqual(['/a']);
  });

  test('refuses a bound that is not a whole number', () => {
    const { disk } = memoryDisk();
    expect(() => storageIsrStore({ disk, maxEntries: Number.NaN })).toThrow(/maxEntries/);
    expect(() => storageIsrStore({ disk, sweepEvery: 0 })).toThrow(/sweepEvery/);
  });
});

describe('storageIsrStore under two controllers', () => {
  const postTag: CacheTag = tag('post');
  const POST = 'apps/web/site/blog/[slug]/page.tsx';
  const restoreGraph = isolateGraph();
  beforeEach(() => {
    clearRoutes();
    resetGraph();
  });
  afterAll(() => {
    clearRoutes();
    restoreGraph();
  });

  test('one replica renders, the other hits; a purge on the other takes it down for both', async () => {
    isrRouteWith(POST, { tags: [postTag], ttl: '10m', onInvalidate: 'purge' });
    const { disk } = memoryDisk();
    const none = (): readonly string[] => [];
    const one = isrController({
      store: storageIsrStore({ disk }),
      routes: describePages,
      isrDependents: none,
    });
    const two = isrController({
      store: storageIsrStore({ disk }),
      routes: describePages,
      isrDependents: none,
    });
    const key = isrKeyIn('/blog/a');
    await one.serve(key, () => '<p>published</p>');
    expect((await two.serve(key, () => '<p>never called</p>')).state).toBe('hit');
    expect(await two.revalidateByTags([postTag])).toEqual([key]);
    expect((await one.serve(key, () => '<p>gone</p>')).state).toBe('miss');
  });

  // Bug hunt, plan 101 slice 14: the process fence was asked BEFORE the store write and never
  // after. Over a disk the write is a round trip, and a `markStale` landing inside it found no page
  // to mark — then the put landed fresh, and a tag-only page answered as a fresh hit for good.
  test('a markStale that lands while the page is being written is not lost', async () => {
    isrRouteWith(POST, { tags: [postTag] });
    const { disk, hooks } = memoryDisk();
    const ctl = isrController({ store: storageIsrStore({ disk }), routes: describePages });
    const key = isrKeyIn('/blog/a');
    hooks.beforePut = async (written) => {
      if (!written.includes('/page/')) return;
      hooks.beforePut = undefined;
      await ctl.markStale(key);
    };
    await ctl.serve(key, () => '<p>before the write</p>');
    const next = await ctl.serve(key, () => '<p>after the write</p>');
    expect(next.state).not.toBe('hit');
  });

  test('a purge that lands while the page is being written takes it down, even with no store fence', async () => {
    isrRouteWith(POST, { tags: [postTag], ttl: '10m', onInvalidate: 'purge' });
    const { disk, hooks } = memoryDisk();
    // Without the store's own fence only the process fence, asked again after the write, sees it.
    const full = storageIsrStore({ disk });
    const store: IsrStore = {
      get: full.get,
      set: full.set,
      markStale: full.markStale,
      delete: full.delete,
      paths: full.paths,
    };
    const ctl = isrController({ store, routes: describePages });
    const key = isrKeyIn('/blog/a');
    hooks.beforePut = async (written) => {
      if (!written.includes('/page/')) return;
      hooks.beforePut = undefined;
      await ctl.revalidateByTags([postTag]);
    };
    await ctl.serve(key, () => '<p>withdrawn</p>');
    expect(await store.get(key)).toBeUndefined();
  });
});
