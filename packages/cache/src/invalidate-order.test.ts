// The ORDER one bust runs in, across everything it reaches. The edge used to be purged first: with
// a `cdn` tier and a slow shared tier behind it, a request arriving between the CDN purge and the
// origin's own delete was answered the old page as a public hit — and the edge, already purged,
// cached it again for a full `s-maxage` with no purge left to remove it.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { isolateGraph, registerDependent, resetGraph } from './graph';
import {
  EVERY_TAG,
  flushProcessTiers,
  invalidateTags,
  isolateTiers,
  purgeEdgeAgain,
  registerInvalidationBroadcast,
  registerRevalidator,
  registerTier,
  resetTiers,
} from './invalidate';
import { isolateDeclaredTags, resetDeclaredTags, tag } from './tags';
import type { CacheTier, TierInvalidation, TierName } from './tiers';

const restoreGraph = isolateGraph();
const restoreTiers = isolateTiers();
const restoreTags = isolateDeclaredTags();

beforeEach(() => {
  resetGraph();
  resetTiers();
  resetDeclaredTags();
});

afterAll(() => {
  restoreGraph();
  restoreTiers();
  restoreTags();
});

function recordingTier(name: TierName, order: string[], fails = false): CacheTier {
  return {
    name,
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(),
    del: () => Promise.resolve(),
    async invalidateTags(): Promise<TierInvalidation> {
      // A real hop, so anything that did not wait for this tier is recorded ahead of it.
      await Bun.sleep(1);
      order.push(name);
      if (fails) return Promise.reject(new Error(`${name} is down`));
      return { tier: name, keys: [] };
    },
  };
}

function wire(order: string[], failing: readonly TierName[] = []): void {
  for (const name of ['request-memo', 'cdn', 'lru', 'redis'] as const) {
    registerTier(recordingTier(name, order, failing.includes(name)));
  }
  registerDependent([tag('post')], { kind: 'isr-route', id: '/blog' });
  registerRevalidator(
    () => {
      order.push('isr');
    },
    () => {
      order.push('isr:held');
      return [];
    },
  );
  registerInvalidationBroadcast(() => {
    order.push('broadcast');
  });
}

describe('unit · the order of one bust', () => {
  test('the read tiers farthest first, then the ISR pages, then the peers, and the edge LAST', async () => {
    const order: string[] = [];
    wire(order);
    const report = await invalidateTags([tag('post')]);
    expect(order).toEqual(['redis', 'lru', 'request-memo', 'isr', 'isr:held', 'broadcast', 'cdn']);
    // The report is still the ladder in read order, whatever order it was cleared in.
    expect(report.tiers.map((entry) => entry.tier)).toEqual([
      'request-memo',
      'lru',
      'redis',
      'cdn',
    ]);
  });

  test('a failing read tier does not keep the origin from dropping the page or the edge from being purged', async () => {
    const order: string[] = [];
    wire(order, ['redis']);
    const report = await invalidateTags([tag('post')]);
    expect(order).toEqual(['redis', 'lru', 'request-memo', 'isr', 'isr:held', 'broadcast', 'cdn']);
    expect(report.errors.map((entry) => entry.tier)).toEqual(['redis']);
  });

  test('a failing edge purge is reported, after everything else has cleared', async () => {
    const order: string[] = [];
    wire(order, ['cdn']);
    const report = await invalidateTags([tag('post')]);
    expect(order.at(-1)).toBe('cdn');
    expect(report.errors.map((entry) => entry.tier)).toEqual(['cdn']);
    expect(report.isr).toEqual(['/blog']);
  });
});

describe('unit · the edge, outside one bust', () => {
  test('purgeEdgeAgain touches the edge and nothing else', async () => {
    const order: string[] = [];
    wire(order);
    const purged = await purgeEdgeAgain(['post:1']);
    expect(order).toEqual(['cdn']);
    expect(purged.map((entry) => entry.tier)).toEqual(['cdn']);
  });

  test('a flush asks the ISR holder for EVERY page, then purges the edge by the tags of the pages it held', async () => {
    const order: string[] = [];
    const edgeTags: string[][] = [];
    registerTier({
      ...recordingTier('cdn', order),
      async invalidateTags(tags) {
        order.push('cdn');
        edgeTags.push(tags.map((one) => one.entity));
        return { tier: 'cdn', keys: [] };
      },
    });
    registerDependent([tag('post')], { kind: 'isr-route', id: '/blog' });
    registerDependent([tag('user')], { kind: 'cache-key', id: 'user:1' });
    const asked: unknown[] = [];
    registerRevalidator(
      () => {
        order.push('isr');
      },
      (tags) => {
        order.push('isr:held');
        asked.push(tags);
        return ['/es/blog'];
      },
    );
    const report = await flushProcessTiers('test');
    expect(order).toEqual(['isr', 'isr:held', 'cdn']);
    expect(asked).toEqual([EVERY_TAG]);
    expect(report.isr).toEqual(['/blog', '/es/blog']);
    // Only what an ISR page carried: a cache key's tag names no document at the edge.
    expect(edgeTags).toEqual([['post']]);
  });
});
