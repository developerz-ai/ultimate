// The purge conformance suite over the noop driver and the Cloudflare and Fastly drivers against
// recorded provider answers (no CDN has a test server), and the proof it can fail: a driver that
// drops every batch past the first, and one that swallows a refusal.

import { describe, expect, test } from 'bun:test';
import type { PurgeDriver, PurgeFetch } from '@ultimat3/cache';
import { cloudflarePurgeDriver, fastlyPurgeDriver, noopPurgeDriver } from '@ultimat3/cache';
import { PURGE_CHECKS, purgeDriverConformance } from './purge-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const answering =
  (body: unknown, status = 200): PurgeFetch =>
  () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

const cloudflare = (fetch: PurgeFetch): PurgeDriver =>
  cloudflarePurgeDriver({
    apiToken: 'cf-token',
    zoneId: 'zone_1',
    baseUrl: 'https://api.cloudflare.test/client/v4',
    fetch,
  });

const fastly = (fetch: PurgeFetch): PurgeDriver =>
  fastlyPurgeDriver({
    apiToken: 'fastly-token',
    serviceId: 'svc_1',
    baseUrl: 'https://api.fastly.test',
    fetch,
  });

describe(testName('unit', 'the noop purge driver'), () => {
  behavesLike(purgeDriverConformance, () => ({ driver: noopPurgeDriver() }));
});

describe(testName('unit', 'the cloudflare purge driver, on recorded answers'), () => {
  behavesLike(purgeDriverConformance, () => ({
    driver: cloudflare(answering({ success: true, errors: [], result: { id: 'zone_1' } })),
    // Cloudflare's refusal arrives as HTTP 200: `response.ok` alone reads it as a purge.
    refused: cloudflare(answering({ success: false, errors: [{ code: 1134, message: 'denied' }] })),
  }));
});

describe(testName('unit', 'the fastly purge driver, on recorded answers'), () => {
  behavesLike(purgeDriverConformance, () => ({
    driver: fastly(answering({})),
    refused: fastly(answering({ msg: 'Provided credentials are missing or invalid' }, 401)),
  }));
});

const check = (name: string) => {
  const found = PURGE_CHECKS.find((each) => each.name.startsWith(name));
  if (found === undefined) return expect.unreachable(`no conformance check named ${name}`);
  return found;
};

describe(testName('unit', 'a driver that breaks the contract fails conformance'), () => {
  test('a purge that sends the first batch and reports it as the whole', async () => {
    const inner = noopPurgeDriver();
    const truncating: PurgeDriver = { ...inner, purge: (keys) => inner.purge(keys.slice(0, 256)) };
    const whole = check('a purge the provider takes whole');
    await expect(whole.run({ driver: truncating })).rejects.toThrow();
    await whole.run({ driver: noopPurgeDriver() });
  });

  test('a driver that swallows the provider’s refusal', async () => {
    const inner = fastly(answering({}, 403));
    const swallowing: PurgeDriver = {
      name: inner.name,
      purge: (keys) => inner.purge(keys).catch(() => keys),
      purgeAll: () => inner.purgeAll().catch(() => undefined),
    };
    const refusal = check('a refused purge');
    await expect(refusal.run({ driver: swallowing, refused: swallowing })).rejects.toThrow();
    await refusal.run({ driver: inner, refused: inner });
  });

  test('every check has a name of its own', () => {
    const names = PURGE_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
