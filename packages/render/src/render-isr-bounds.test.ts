// The finite-bound half of `render-isr.ts`, split out of `render-isr.test.ts` when that file
// crossed the 500-line ceiling. One file, one responsibility: this one owns what happens when a
// cap or a TTL arrives non-finite, and nothing here touches tag invalidation or key derivation.

import { describe, expect, test } from 'bun:test';
import { createIsrController, memoryIsrStore } from './render-isr';

/**
 * A bound whose own value is `NaN` makes its guard read false: `map.size > NaN` is false for
 * every size, so the cap stops existing rather than being enforced wrongly. `??` guards nullish
 * and `NaN` is not nullish, so a `maxEntries` read from a config or an env value arrives intact.
 */
describe('a non-finite bound is refused, not propagated', () => {
  test('memoryIsrStore refuses a NaN maxEntries instead of holding every page ever rendered', () => {
    expect(() => memoryIsrStore({ maxEntries: Number.NaN })).toThrow(/maxEntries/);
  });

  test('memoryIsrStore refuses a fractional maxEntries — half a page is not an eviction point', () => {
    expect(() => memoryIsrStore({ maxEntries: 2.5 })).toThrow(/maxEntries/);
  });

  /**
   * `IsrStore` is a driver seam, so an entry can come back from an app's own store — a Redis one
   * round-trips it through JSON, where a missing `ttlMs` is `undefined` and `entry.ttlMs === null`
   * is then false. Two failures follow from one value, and neither raises: `now - generatedAt <
   * NaN` is false so the page is NEVER fresh (a regeneration per request), and the CDN is handed
   * `s-maxage=NaN`, an unparseable directive a conforming cache IGNORES — so the page silently
   * falls back to heuristic caching instead of the declared age.
   */
  test('a store answering a non-finite ttl serves a parseable directive, and stays fresh', async () => {
    const entry = {
      path: '/blog',
      html: '<p>blog</p>',
      hash: 'h1',
      generatedAt: 0,
      ttlMs: Number.NaN,
      stale: false,
    };
    const controller = createIsrController({
      buildId: 'b1',
      now: () => 1_000,
      routes: () => [],
      store: {
        get: () => entry,
        set: () => undefined,
        markStale: () => false,
        delete: () => undefined,
        paths: () => ['/blog'],
      },
    });

    const served = await controller.serve('/blog', () => '<p>blog</p>');

    expect(served.result.headers['cache-control']).toMatch(
      /^public, max-age=0, s-maxage=\d+, stale-while-revalidate=86400$/,
    );
    expect(served.state).toBe('hit');
  });
});
