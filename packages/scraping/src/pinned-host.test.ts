// The DNS half of `allowHosts`. A wildcard admits names, and a name can resolve anywhere: the
// metadata service, loopback, the cluster. Resolved with an INJECTED resolver — the network is
// sealed here and a real lookup would make the suite depend on the machine's DNS.

import { describe, expect, test } from 'bun:test';
import { testScrapeClock } from './clock';
import { httpOverFetch, type ScrapeFetchInit } from './http';
import type { HostResolve } from './pinned-host';
import { dialTarget } from './pinned-host';
import type { NetworkEntry } from './rings';
import { boundedRing } from './rings';
import { robotsFetcher } from './robots-fetch';
import { EMPTY_SESSION } from './session-state';

const answering =
  (table: Readonly<Record<string, readonly string[]>>): HostResolve =>
  (hostname) =>
    Promise.resolve(table[hostname] ?? []);

const RESOLVER = answering({
  'shop.test': ['93.184.216.34'],
  'metadata.test': ['169.254.169.254'],
  'split.test': ['93.184.216.34', '10.0.0.7'],
  'loop.test': ['::1'],
});

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

describe('unit · dialTarget resolves what a wildcard admitted, and pins it', () => {
  test('a name that resolves public is pinned to that address, proving the name', async () => {
    expect(await dialTarget('https://shop.test:8443/a?b=1', ['*'], RESOLVER)).toEqual({
      url: 'https://93.184.216.34:8443/a?b=1',
      host: 'shop.test:8443',
      serverName: 'shop.test',
    });
  });

  test('plain http is pinned with a Host header and no serverName', async () => {
    expect(await dialTarget('http://shop.test/a', ['*.test'], RESOLVER)).toEqual({
      url: 'http://93.184.216.34/a',
      host: 'shop.test',
    });
  });

  for (const [host, kind] of [
    ['metadata.test', 'link-local'],
    ['split.test', 'private'],
    ['loop.test', 'loopback'],
    ['nowhere.test', 'no address'],
  ] as const) {
    test(`a name resolving to ${kind} is refused, terminal, naming the class and not the address`, async () => {
      let thrown: { code?: string; cause?: string; retry?: string } = {};
      try {
        await dialTarget(`https://${host}/`, ['*'], RESOLVER);
      } catch (error) {
        thrown = error as typeof thrown;
      }
      expect(thrown.code).toBe('X_SCRAPE_HOST_BLOCKED');
      expect(thrown.retry).toBe('terminal');
      expect(thrown.cause).toContain(kind);
      expect(thrown.cause).not.toContain('169.254');
    });
  }

  test('an exact rule is the app naming the host: not resolved, not pinned', async () => {
    let asked = 0;
    const counting: HostResolve = (hostname) => {
      asked += 1;
      return RESOLVER(hostname);
    };
    expect(await dialTarget('https://metadata.test/', ['metadata.test', '*'], counting)).toEqual({
      url: 'https://metadata.test/',
    });
    expect(asked).toBe(0);
  });

  test('an address literal is left to core’s floor, unresolved', async () => {
    expect(await dialTarget('https://93.184.216.34/', ['*'], RESOLVER)).toEqual({
      url: 'https://93.184.216.34/',
    });
  });

  test('a resolver failure propagates — nothing unscreened is dialled', async () => {
    const failing: HostResolve = () => Promise.reject(new Error('ENOTFOUND'));
    await expect(dialTarget('https://shop.test/', ['*'], failing)).rejects.toThrow('ENOTFOUND');
  });
});

describe('unit · both legs this package dials pin, and refuse an inward name', () => {
  const recordingFetch = () => {
    const seen: { url: string; init: ScrapeFetchInit }[] = [];
    const call = (url: string, init: ScrapeFetchInit) => {
      seen.push({ url, init });
      const location = url.includes('/hop') ? null : 'https://metadata.test/latest';
      return Promise.resolve(
        location === null || !url.endsWith('/start')
          ? new Response('{}', { status: 200 })
          : new Response(null, { status: 302, headers: { location } }),
      );
    };
    return { seen, call };
  };

  const http = (call: ReturnType<typeof recordingFetch>['call'], proxy?: string) =>
    httpOverFetch({
      rules: { allowHosts: ['*'] },
      clock: testScrapeClock(),
      timeoutMs: 1_000,
      network: boundedRing<NetworkEntry>(),
      session: () => Promise.resolve(EMPTY_SESSION),
      fetch: call,
      resolve: RESOLVER,
      proxy,
    });

  test('the HTTP leg dials the pinned address with the name as Host and serverName', async () => {
    const { seen, call } = recordingFetch();
    await http(call).request('https://shop.test/hop');
    expect(seen[0]?.url).toBe('https://93.184.216.34/hop');
    expect(new Headers(seen[0]?.init.headers).get('host')).toBe('shop.test');
    expect(seen[0]?.init.tls).toEqual({ serverName: 'shop.test' });
  });

  test('the HTTP leg refuses a redirect hop whose name resolves inward, before dialling it', async () => {
    const { seen, call } = recordingFetch();
    expect(await codeOf(() => http(call).request('https://shop.test/start'))).toBe(
      'X_SCRAPE_HOST_BLOCKED',
    );
    expect(seen.map((entry) => entry.url)).toEqual(['https://93.184.216.34/start']);
  });

  test('through a proxy the PROXY resolves, so the name is dialled unpinned', async () => {
    const { seen, call } = recordingFetch();
    await http(call, 'http://exit.test:1').request('https://shop.test/hop');
    expect(seen[0]?.url).toBe('https://shop.test/hop');
  });

  test('the robots read pins too, and reads an inward name as "no robots"', async () => {
    const { seen, call } = recordingFetch();
    const read = robotsFetcher({ allowHosts: ['*'], fetch: call, resolve: RESOLVER });
    await read('https://shop.test/hop/robots.txt');
    expect(seen[0]?.url).toBe('https://93.184.216.34/hop/robots.txt');
    expect(await read('https://metadata.test/robots.txt')).toBeUndefined();
    expect(seen).toHaveLength(1);
  });
});
