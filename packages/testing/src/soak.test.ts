// The soak's verdict: a handler that keeps something per request is refused with the growth it
// caused; one that keeps nothing passes; the options a caller can get wrong are screened.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { measureSoak, SoakHeapGrowthError, soak } from './soak';

const ping = (): Request => new Request('http://soak.test/ping');
const flat = (): Response => new Response('ok');

/** 4 KiB retained per request: 3,000 requests hold ~12 MiB the bound below cannot hide. */
const leaked: string[] = [];
const leaky = (request: Request): Response => {
  leaked.push(`${request.url}:${'x'.repeat(4_096)}:${leaked.length}`);
  return new Response('ok');
};

describe('soak()', () => {
  test('a handler that keeps a value per request is refused with its growth', async () => {
    let caught: unknown;
    try {
      await soak({
        fetch: leaky,
        requests: [ping],
        total: 3_000,
        warmup: 100,
        maxGrowthBytes: 2 * 1024 * 1024,
      });
    } catch (error) {
      caught = error;
    }
    leaked.length = 0;
    expect(caught).toBeInstanceOf(SoakHeapGrowthError);
    expect(isUltimateError(caught) && caught.code).toBe('X_TEST_SOAK_HEAP_GROWTH');
    const growth = isUltimateError(caught) ? caught.meta?.['growthBytes'] : undefined;
    expect(typeof growth === 'number' && growth > 3_000 * 4_096).toBe(true);
  });

  test('a handler that keeps nothing passes, and every status is counted', async () => {
    const report = await soak({
      fetch: flat,
      requests: [ping],
      total: 3_000,
      warmup: 100,
      maxGrowthBytes: 2 * 1024 * 1024,
    });
    expect(report.requests).toBe(3_000);
    expect(report.statuses.get(200)).toBe(3_000);
  });

  test('requests are sent round-robin', async () => {
    const seen: string[] = [];
    const make = (path: string) => (): Request => new Request(`http://soak.test${path}`);
    await measureSoak({
      fetch: (request) => {
        seen.push(new URL(request.url).pathname);
        return new Response(null, { status: 204 });
      },
      requests: [make('/a'), make('/b'), make('/c')],
      total: 6,
      warmup: 0,
      maxGrowthBytes: 0,
    });
    expect(seen).toEqual(['/a', '/b', '/c', '/a', '/b', '/c']);
  });

  test('an unreadable count or bound is refused before a request is sent', async () => {
    await expect(
      soak({ fetch: flat, requests: [ping], maxGrowthBytes: Number.NaN }),
    ).rejects.toThrow(/maxGrowthBytes/);
    await expect(
      measureSoak({ fetch: flat, requests: [ping], total: 0, maxGrowthBytes: 1 }),
    ).rejects.toThrow(/total/);
  });
});
