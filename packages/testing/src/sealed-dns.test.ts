// The sealed network seals NAME RESOLUTION as it seals `fetch`: a mocked host resolves to a public
// address (so an SSRF screen passes it and the pinned dial still meets the mock), an unmocked one is
// refused with the seal's own code, offline refuses every name, and this machine resolves for real.

import { afterEach, describe, expect, test } from 'bun:test';
// why: the seal must cover Bun's node:dns lookups, so the test drives that very module.
import nodeDns from 'node:dns';
import { classifyAddress } from '@ultimat3/core';
import { screenDial } from '@ultimat3/core/outbound';
import {
  allowHost,
  MOCKED_HOST_ADDRESS,
  mockFetch,
  resetNetwork,
  sealNetwork,
  setNetworkState,
} from './sealed-network';
import { testName } from './test-types';

sealNetwork();

afterEach(() => {
  resetNetwork();
});

const refusal = async (pending: Promise<unknown>): Promise<{ code?: string; fix?: string }> =>
  pending.then(
    () => expect.unreachable('the lookup resolved'),
    (error: unknown) => error as { code?: string; fix?: string },
  );

const nodeLookup = (hostname: string): Promise<string> =>
  new Promise((resolve, reject) => {
    nodeDns.lookup(hostname, (error, address) =>
      error === null ? resolve(address) : reject(error),
    );
  });

describe(testName('unit', 'sealed dns'), () => {
  test('a mocked host resolves to the one public address, through every resolver', async () => {
    mockFetch('https://vendor.example/*', () => new Response('{}'));
    expect(classifyAddress(MOCKED_HOST_ADDRESS)).toBe('public');
    expect((await Bun.dns.lookup('vendor.example')).map((one) => one.address)).toEqual([
      MOCKED_HOST_ADDRESS,
    ]);
    expect(await nodeLookup('vendor.example')).toBe(MOCKED_HOST_ADDRESS);
    expect((await nodeDns.promises.lookup('vendor.example')).address).toBe(MOCKED_HOST_ADDRESS);
  });

  test('a regex mock names its host too', async () => {
    mockFetch(/^https:\/\/feeds\.example\/rss/, () => new Response('{}'));
    expect((await Bun.dns.lookup('feeds.example'))[0]?.address).toBe(MOCKED_HOST_ADDRESS);
  });

  test('an SSRF screen passes a mocked host, and the pinned dial meets the mock', async () => {
    mockFetch('https://vendor.example/*', () => new Response('pinned'));
    const verdict = await screenDial(new URL('https://vendor.example/v1/feed'));
    if (!('pin' in verdict)) return expect.unreachable('the screen refused a mocked host');
    const answer = await fetch(verdict.pin.url, { headers: { host: verdict.pin.host } });
    expect(await answer.text()).toBe('pinned');
  });

  test('an unmocked host is refused with the seal’s own code, on every resolver', async () => {
    const bun = await refusal(Bun.dns.lookup('unmocked.example'));
    expect(bun.code).toBe('X_TEST_NETWORK_SEALED');
    expect(bun.fix).toContain("mockFetch('https://unmocked.example/*'");
    expect((await refusal(nodeLookup('unmocked.example'))).code).toBe('X_TEST_NETWORK_SEALED');
    expect((await refusal(nodeDns.promises.lookup('unmocked.example'))).code).toBe(
      'X_TEST_NETWORK_SEALED',
    );
  });

  test('offline refuses every name; this machine resolves for real', async () => {
    expect((await Bun.dns.lookup('localhost')).length).toBeGreaterThan(0);
    mockFetch('https://vendor.example/*', () => new Response('{}'));
    setNetworkState('offline');
    expect((await refusal(Bun.dns.lookup('vendor.example'))).code).toBe('X_TEST_NETWORK_OFFLINE');
  });

  test('an allowed host is handed to the real resolver', async () => {
    allowHost('localhost:8080');
    expect((await Bun.dns.lookup('localhost')).length).toBeGreaterThan(0);
  });
});
