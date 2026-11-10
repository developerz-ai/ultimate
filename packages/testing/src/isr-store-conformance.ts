// The `IsrStore` contract as shared examples: `behavesLike(isrStoreConformance, () => store)` runs
// every check against a store of your own — memory, over a disk, over your database. Each check
// writes paths of its own, so one shared store serves every test and asserts containment only.

import { expect, test } from 'bun:test';
import type { IsrEntry, IsrStore } from '@ultimat3/render/server';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface IsrStoreCheck {
  readonly name: string;
  run(store: IsrStore): Promise<void>;
}

const scopeOf = (): string => `/conformance-${crypto.randomUUID()}`;

const entryOf = (path: string, html = `<p>${path}</p>`): IsrEntry => ({
  path,
  html,
  hash: `h-${html.length}`,
  generatedAt: 1_000,
  ttlMs: 60_000,
  stale: false,
  status: 200,
});

export const ISR_STORE_CHECKS: readonly IsrStoreCheck[] = [
  {
    name: 'a set entry reads back whole, and an unheld path is undefined',
    async run(store) {
      const path = `${scopeOf()}/a`;
      expect(await store.get(path)).toBeUndefined();
      const entry = { ...entryOf(path), status: 404 };
      await store.set(entry);
      expect(await store.get(path)).toEqual(entry);
      expect(await store.paths()).toContain(path);
    },
  },
  {
    name: 'the query is part of the key: /p?page=2 and /p?page=3 are two pages',
    async run(store) {
      const base = `${scopeOf()}/precios-espa%C3%B1a`;
      const [two, three] = [`${base}?page=2&__x_locale=es`, `${base}?page=3&__x_locale=es`];
      await store.set(entryOf(two, 'two'));
      await store.set(entryOf(three, 'three'));
      expect([(await store.get(two))?.html, (await store.get(three))?.html]).toEqual([
        'two',
        'three',
      ]);
      expect(await store.get(base)).toBeUndefined();
    },
  },
  {
    name: 'a re-set replaces the page, its html and its stale mark alike',
    async run(store) {
      const path = `${scopeOf()}/r`;
      await store.set(entryOf(path, 'old'));
      await store.markStale(path);
      await store.set(entryOf(path, 'new'));
      expect(await store.get(path)).toMatchObject({ html: 'new', stale: false });
    },
  },
  {
    name: 'markStale marks a held page in place, and answers false for one it never held',
    async run(store) {
      const path = `${scopeOf()}/s`;
      await store.set(entryOf(path));
      expect(await store.markStale(path)).toBe(true);
      expect(await store.get(path)).toEqual({ ...entryOf(path), stale: true });
      expect(await store.markStale(`${scopeOf()}/never`)).toBe(false);
    },
  },
  {
    name: 'delete takes the page out of get, markStale and paths',
    async run(store) {
      const path = `${scopeOf()}/d`;
      await store.set(entryOf(path));
      await store.delete(path);
      expect(await store.get(path)).toBeUndefined();
      expect(await store.markStale(path)).toBe(false);
      expect(await store.paths()).not.toContain(path);
      await store.delete(path);
    },
  },
  {
    name: 'a tag fence refuses a write whose reading a bump made void, and takes a current one',
    async run(store) {
      // Optional on the port: a store without one is refused at boot when a route purges.
      const fence = store.tagFence;
      if (fence === undefined) return;
      const [path, entity] = [`${scopeOf()}/f`, `e${crypto.randomUUID().slice(0, 8)}`];
      const stale = await fence.sample([entity]);
      await fence.bump([entity]);
      expect(await fence.setIfCurrent(entryOf(path), [entity], stale)).toBe(false);
      expect(await store.get(path)).toBeUndefined();
      const current = await fence.sample([entity]);
      expect(current).not.toBe(stale);
      expect(await fence.setIfCurrent(entryOf(path), [entity], current)).toBe(true);
      expect((await store.get(path))?.html).toBe(entryOf(path).html);
    },
  },
];

export const isrStoreConformance: SharedExamples<IsrStore | Promise<IsrStore>> = sharedExamples(
  'an ISR store',
  (subject) => {
    for (const check of ISR_STORE_CHECKS) {
      test(check.name, async () => {
        await check.run(await subject());
      });
    }
  },
);
