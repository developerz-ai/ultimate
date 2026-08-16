// Cross-instance invalidation, both halves. `invalidate.test.ts` owns the local fan-out; this
// file owns what leaves the process and what arrives from another one — and the property that
// matters most is the one that is NOT there: the inbound half never re-emits.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  invalidateTags,
  isolateTiers,
  receiveInvalidationBroadcast,
  registerInvalidationBroadcast,
  registerTier,
  resetTiers,
} from './invalidate';
import { createLruTier } from './lru';
import { declareTags, isolateDeclaredTags, resetDeclaredTags, tag } from './tags';

// Module scope, so the baseline is whatever a neighbouring file registered before this one ran.
const restoreRegistries = [isolateTiers(), isolateDeclaredTags()];

beforeEach(() => {
  resetTiers();
  resetDeclaredTags();
});

afterAll(() => {
  for (const restore of restoreRegistries) restore();
});

describe('cross-instance invalidation', () => {
  // Without the seam `invalidateTags` clears ONE process's LRU: a user edits their profile on
  // pod 3, their next request lands on pod 7, and pod 7 serves the pre-edit value for up to
  // `defaultTtlMs`. The user watches the edit vanish and re-submits.
  test('a local fan-out hands its wire tags to the registered broadcast, last', async () => {
    const order: string[] = [];
    const lru = createLruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    registerTier({
      ...lru,
      async invalidateTags(tags) {
        order.push('tier');
        return await lru.invalidateTags(tags);
      },
    });
    registerInvalidationBroadcast((wire) => {
      order.push(`broadcast:${wire.join(',')}`);
    });

    const report = await invalidateTags([tag('post', '1')]);

    expect(order).toEqual(['tier', 'broadcast:post:1']);
    expect(report.errors).toEqual([]);
  });

  test('the INBOUND half applies the tags and cannot re-emit — a broadcast storm is structural', async () => {
    const lru = createLruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);
    await lru.set('feed', ['a'], { tags: [tag('post')] });

    let sends = 0;
    registerInvalidationBroadcast(async (wire) => {
      sends += 1;
      // The storm, attempted: a receiver that re-broadcast would recurse without a bound.
      await receiveInvalidationBroadcast(wire);
    });

    const report = await receiveInvalidationBroadcast(['post:1']);

    expect(sends).toBe(0);
    expect(report.tags).toEqual(['post:1']);
    expect(await lru.get('feed')).toBeUndefined();
  });

  test('a local bust whose receiver echoes back still sends exactly once', async () => {
    let sends = 0;
    registerInvalidationBroadcast(async (wire) => {
      sends += 1;
      await receiveInvalidationBroadcast(wire);
    });

    await invalidateTags([tag('post', '1')]);

    expect(sends).toBe(1);
  });

  test('a dead transport is reported, never thrown — the write that triggered it must not fail', async () => {
    const lru = createLruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);
    await lru.set('feed', ['a'], { tags: [tag('post')] });
    registerInvalidationBroadcast(() => Promise.reject(new Error('nats is down')));

    const report = await invalidateTags([tag('post')]);

    expect(report.errors).toEqual([{ tier: 'broadcast', message: 'nats is down' }]);
    // The local tiers still cleared: a partial bust, honestly reported.
    expect(report.tiers.map((entry) => entry.tier)).toEqual(['lru']);
    expect(await lru.get('feed')).toBeUndefined();
  });

  test('an empty bust sends nothing at all', async () => {
    let sends = 0;
    registerInvalidationBroadcast(() => {
      sends += 1;
    });

    await invalidateTags([]);

    expect(sends).toBe(0);
  });

  test('an inbound tag this process never declared is dropped and reported, never thrown', async () => {
    // Mid-deploy the new pods know an entity the old ones do not. A throw here kills the
    // subscriber loop that delivered it, silently ending cross-instance invalidation.
    declareTags(['post']);
    const lru = createLruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);
    await lru.set('feed', ['a'], { tags: [tag('post')] });

    const report = await receiveInvalidationBroadcast(['post:1', 'comment:9']);

    expect(report.tags).toEqual(['post:1']);
    expect(report.errors).toEqual([
      { tier: 'broadcast', message: 'ignored undeclared tag "comment:9"' },
    ]);
    expect(await lru.get('feed')).toBeUndefined();
  });

  test('resetTiers drops the broadcast along with everything else it drops', async () => {
    let sends = 0;
    registerInvalidationBroadcast(() => {
      sends += 1;
    });
    resetTiers();

    await invalidateTags([tag('post')]);

    expect(sends).toBe(0);
  });
});
