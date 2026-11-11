// A page load is dozens of content-hashed GETs from one address. Through the real pipeline with
// the SHIPPED limits: 300 island chunks from one address are all served, while a plain POST still
// meets `default` at its 121st call — the `assets` bucket widened assets, nothing else.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { installClock } from '@ultimat3/core/adapter';
import { defineHttpConfig, httpServer, jsonResponse, type Route } from '@ultimat3/http';
import { ISLAND_BASE_PATH, islandBundle } from './island-bundle';
import { islandRoutes } from './island-routes';

// Frozen: no bucket refills mid-loop, so the counts below are exact on any machine.
let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
});

const write: Route = {
  method: 'POST',
  path: '/write',
  meta: { name: 'write', auth: 'public' },
  handler: () => jsonResponse({ ok: true }),
};

/** One process limiter, every request from the one (socketless, so unknown) address. */
const server = () =>
  httpServer({
    routes: [...islandRoutes(() => islandBundle([])), write],
    role: 'web',
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
  });

const statuses = async (
  handle: ReturnType<typeof server>,
  count: number,
  request: (index: number) => Request,
): Promise<number[]> => {
  const seen: number[] = [];
  for (let i = 0; i < count; i += 1) seen.push((await handle.fetch(request(i))).status);
  return seen;
};

describe('unit · asset routes under the shipped rate limit', () => {
  test('300 island-chunk GETs from one address: none is 429', async () => {
    release = installClock(frozenClock(1_000_000));
    const seen = await statuses(
      server(),
      300,
      (index) => new Request(`http://app.test${ISLAND_BASE_PATH}/missing-${String(index)}.js`),
    );
    // A miss is 404 — the route answered; only the limiter answers 429.
    expect(seen.filter((status) => status === 429)).toHaveLength(0);
    expect(new Set(seen)).toEqual(new Set([404]));
  });

  test('121 POSTs from one address: the 121st is 429, `default` is unchanged', async () => {
    release = installClock(frozenClock(1_000_000));
    const seen = await statuses(
      server(),
      121,
      () => new Request('http://app.test/write', { method: 'POST', body: '{}' }),
    );
    expect(seen.slice(0, 120).every((status) => status !== 429)).toBe(true);
    expect(seen.at(-1)).toBe(429);
  });
});
