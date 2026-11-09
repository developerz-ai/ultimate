// The browser leg's DNS screen. `allowHosts: ['*']` admits any NAME, and a name that resolves to
// `10.0.0.1` or the metadata endpoint is the SSRF the HTTP leg already refuses (`pinned-host.ts`).
// The browser dials by itself, so the screen runs before the request is released: page-level
// `continue()` and browser-level `Fetch.continueRequest` alike.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { arm, armBrowser } from './cdp-arm';
import { fakeBrowserTarget } from './cdp-fake-target-fixture';
import type { CdpBrowserLike, CdpPageLike } from './cdp-port';
import type { HostResolve } from './pinned-host';
import { boundedRing, type NetworkEntry } from './rings';

const ADDRESSES: Readonly<Record<string, readonly string[]>> = {
  'inner.test': ['10.0.0.1'],
  'metadata.test': ['169.254.169.254'],
  'mixed.test': ['93.184.216.34', '127.0.0.1'],
  'public.test': ['93.184.216.34'],
};

const fakeResolver = () => {
  const asked: string[] = [];
  const resolve: HostResolve = (hostname) => {
    asked.push(hostname);
    const answer = ADDRESSES[hostname];
    return answer === undefined
      ? Promise.reject(new Error(`ENOTFOUND ${hostname}`))
      : Promise.resolve(answer);
  };
  return { resolve, asked };
};

// One event-loop turn: the injected resolver answers in microtasks, so every screen has decided —
// and every `continue`/`failRequest` been sent — by the time a macrotask runs.
const settle = () => Bun.sleep(0);

const armedBrowser = async (allowHosts: readonly string[], proxied = false) => {
  const fake = fakeBrowserTarget();
  const browser = { target: () => fake.target } as unknown as CdpBrowserLike;
  const network = boundedRing<NetworkEntry>();
  const { resolve, asked } = fakeResolver();
  await armBrowser(
    { browser, rules: { allowHosts }, clock: frozenClock(), resolve, proxied },
    network,
  );
  return { fake, network, asked };
};

const fakePage = () => {
  const handlers = new Map<string, (payload: unknown) => void>();
  const page = {
    setRequestInterception: () => Promise.resolve(),
    on: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
      return undefined;
    },
  } as unknown as CdpPageLike;
  return { page, fire: (event: string, payload: unknown) => handlers.get(event)?.(payload) };
};

const armedPage = async (allowHosts: readonly string[], proxied = false) => {
  const { page, fire } = fakePage();
  const network = boundedRing<NetworkEntry>();
  const { resolve, asked } = fakeResolver();
  await arm(
    { page, rules: { allowHosts }, clock: frozenClock(), resolve, proxied },
    { network, console: boundedRing(), pageErrors: boundedRing(), crashed: { value: undefined } },
  );
  const outcomes: string[] = [];
  const request = (url: string) => {
    fire('request', {
      url: () => url,
      resourceType: () => 'document',
      method: () => 'GET',
      continue: () => {
        outcomes.push(`continue ${url}`);
        return Promise.resolve();
      },
      abort: () => {
        outcomes.push(`abort ${url}`);
        return Promise.resolve();
      },
    });
  };
  return { request, network, outcomes, asked };
};

describe('unit · armBrowser screens a wildcard-admitted name before releasing it', () => {
  test.each([
    ['RFC 1918', 'http://inner.test/'],
    ['the metadata endpoint', 'http://metadata.test/latest/meta-data/'],
    ['one inward address among public ones', 'https://mixed.test/'],
    ['a name that does not resolve', 'https://nowhere.test/'],
  ])('%s: Fetch.failRequest, ring entry refused host', async (_label, url) => {
    const { fake, network } = await armedBrowser(['*']);
    fake.emitTargetRequest(url, 'Document');
    await settle();
    expect(fake.browserFetch.failed).toEqual([url]);
    expect(fake.browserFetch.continued).toEqual([]);
    expect(network.entries()).toEqual([expect.objectContaining({ url, refused: 'host' })]);
  });

  test('a subdomain wildcard is screened the same way', async () => {
    const { fake } = await armedBrowser(['*.test']);
    fake.emitTargetRequest('http://inner.test/', 'Document');
    await settle();
    expect(fake.browserFetch.failed).toEqual(['http://inner.test/']);
  });

  test('a public answer continues', async () => {
    const { fake, network } = await armedBrowser(['*']);
    fake.emitTargetRequest('https://public.test/', 'Document');
    await settle();
    expect(fake.browserFetch.continued).toEqual(['https://public.test/']);
    expect(network.entries()).toEqual([]);
  });

  test('an EXACT rule is the opt-in: no resolve, the request continues', async () => {
    const { fake, asked } = await armedBrowser(['inner.test']);
    fake.emitTargetRequest('http://inner.test/', 'Document');
    await settle();
    expect(asked).toEqual([]);
    expect(fake.browserFetch.continued).toEqual(['http://inner.test/']);
  });

  test('through a proxy the exit resolves the name, so this box does not', async () => {
    const { fake, asked } = await armedBrowser(['*'], true);
    fake.emitTargetRequest('http://inner.test/', 'Document');
    await settle();
    expect(asked).toEqual([]);
    expect(fake.browserFetch.continued).toEqual(['http://inner.test/']);
  });

  test('hostless schemes are never resolved', async () => {
    const { fake, asked } = await armedBrowser(['*']);
    fake.emitTargetRequest('data:text/plain,hi', 'Document');
    await settle();
    expect(asked).toEqual([]);
    expect(fake.browserFetch.continued).toEqual(['data:text/plain,hi']);
  });
});

describe('unit · arm screens the page request before continue()', () => {
  test('a wildcard-admitted name resolving inward is aborted and recorded as a host refusal', async () => {
    const { request, network, outcomes } = await armedPage(['*']);
    request('http://metadata.test/latest/meta-data/');
    await settle();
    expect(outcomes).toEqual(['abort http://metadata.test/latest/meta-data/']);
    expect(network.entries()).toEqual([
      expect.objectContaining({ url: 'http://metadata.test/latest/meta-data/', refused: 'host' }),
    ]);
  });

  test('a public answer continues and is recorded once, unrefused', async () => {
    const { request, network, outcomes } = await armedPage(['*']);
    request('https://public.test/');
    await settle();
    expect(outcomes).toEqual(['continue https://public.test/']);
    expect(network.entries().map((entry) => [entry.url, entry.refused])).toEqual([
      ['https://public.test/', undefined],
    ]);
  });

  test('an exact rule continues synchronously, without a resolve', async () => {
    const { request, outcomes, asked } = await armedPage(['inner.test']);
    request('http://inner.test/');
    expect(outcomes).toEqual(['continue http://inner.test/']);
    expect(asked).toEqual([]);
  });
});

// The OPEN half (`wiki/Known-Gaps.md`): the screen decides, but the request is released by NAME.
// `Fetch.continueRequest` carries the request id alone — no address — so Chrome resolves again for
// itself, and a name that answers public here and private to Chrome (DNS rebinding) is reached.
// The day this port can pin the browser's dial, this test goes red and the row closes.
describe('known gap · the browser leg cannot pin the address it screened', () => {
  test('a screened name is continued by request id only, never pinned to the approved address', async () => {
    const sent: { method: string; params: Record<string, unknown> | undefined }[] = [];
    let paused: ((payload: unknown) => void) | undefined;
    const session = {
      send: (method: string, params?: Record<string, unknown>) => {
        sent.push({ method, params });
        return Promise.resolve({});
      },
      detach: () => Promise.resolve(),
      on: (_event: string, handler: (payload: unknown) => void) => {
        paused = handler;
        return undefined;
      },
    };
    const browser = {
      target: () => ({ createCDPSession: () => Promise.resolve(session) }),
    } as unknown as CdpBrowserLike;
    const { resolve } = fakeResolver();
    await armBrowser(
      { browser, rules: { allowHosts: ['*'] }, clock: frozenClock(), resolve },
      boundedRing<NetworkEntry>(),
    );
    paused?.({
      requestId: 'r1',
      resourceType: 'Document',
      request: { url: 'https://public.test/' },
    });
    await settle();
    expect(sent.filter((call) => call.method === 'Fetch.continueRequest')).toEqual([
      { method: 'Fetch.continueRequest', params: { requestId: 'r1' } },
    ]);
  });
});
