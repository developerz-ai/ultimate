// The `semanticCache` port's contract as shared examples:
// `behavesLike(semanticCacheFactoryConformance, () => (scope) => yours(scope))`. The port is a
// FACTORY, one cache per scope, because two tenants asking near-identical questions of one shared
// cache is one tenant reading the other's answer — so scope isolation is the first check.

import { expect, test } from 'bun:test';
import type { SemanticCacheFactory } from '@ultimat3/ai/adapter';
import { uuidV7 } from '@ultimat3/core';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface SemanticCacheFactoryCheck {
  readonly name: string;
  run(factory: SemanticCacheFactory): Promise<void>;
}

/** A fresh scope per check, so a durable store's rows from an earlier check never answer. */
const scope = (label: string): string => `conformance-${label}-${uuidV7()}`;

const NORTH = [1, 0, 0] as const;
const EAST = [0, 1, 0] as const;

export const SEMANTIC_CACHE_FACTORY_CHECKS: readonly SemanticCacheFactoryCheck[] = [
  {
    name: 'two scopes are two caches: what one remembers the other never answers',
    async run(factory) {
      const a = factory(scope('a'));
      const b = factory(scope('b'));
      await a.remember('k', NORTH, 'org-a answer');
      expect(await b.lookup(NORTH, 0.9)).toBeUndefined();
      expect((await a.lookup<string>(NORTH, 0.9))?.value).toBe('org-a answer');
    },
  },
  {
    name: 'a remembered embedding answers its own lookup, with its key and a similarity near 1',
    async run(factory) {
      const cache = factory(scope('hit'));
      expect(cache.name.length).toBeGreaterThan(0);
      await cache.remember('the-key', NORTH, { answer: 42 });
      const hit = await cache.lookup<{ answer: number }>(NORTH, 0.9);
      expect(hit?.key).toBe('the-key');
      expect(hit?.value).toEqual({ answer: 42 });
      expect(hit?.similarity).toBeGreaterThan(0.999);
    },
  },
  {
    name: 'below the threshold is a miss, never the nearest entry anyway',
    async run(factory) {
      const cache = factory(scope('miss'));
      await cache.remember('north', NORTH, 'north');
      expect(await cache.lookup(EAST, 0.9)).toBeUndefined();
    },
  },
  {
    name: 'an embedding that is not a number is not a match',
    async run(factory) {
      const cache = factory(scope('nan'));
      await cache.remember('north', NORTH, 'north');
      expect(await cache.lookup([1, Number.NaN, 0], 0.5)).toBeUndefined();
    },
  },
  {
    name: 'invalidateTags drops the tagged entries, names their keys, and keeps the rest',
    async run(factory) {
      const cache = factory(scope('tags'));
      await cache.remember('tagged', NORTH, 'tagged', { tags: [{ entity: 'post', id: '1' }] });
      await cache.remember('kept', EAST, 'kept', { tags: [{ entity: 'post', id: '2' }] });
      expect(await cache.size()).toBe(2);
      expect(await cache.invalidateTags([{ entity: 'post', id: '1' }])).toEqual(['tagged']);
      expect(await cache.lookup(NORTH, 0.9)).toBeUndefined();
      expect((await cache.lookup<string>(EAST, 0.9))?.value).toBe('kept');
      expect(await cache.size()).toBe(1);
    },
  },
];

export const semanticCacheFactoryConformance: SharedExamples<SemanticCacheFactory> = sharedExamples(
  'a semantic cache factory',
  (subject) => {
    for (const check of SEMANTIC_CACHE_FACTORY_CHECKS) {
      test(check.name, async () => {
        await check.run(subject());
      });
    }
  },
);
