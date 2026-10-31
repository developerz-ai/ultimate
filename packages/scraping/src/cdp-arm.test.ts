// Single responsibility: the interception handler never floats a rejection. `request.continue()`
// and `request.abort()` reject when the target closed mid-request — and on any other protocol
// error — and `void` left that as an unhandled rejection, which Bun ends the process on.

import { afterEach, describe, expect, test } from 'bun:test';
import { arm } from './cdp-arm';
import type { CdpPageLike } from './cdp-port';
import { testScrapeClock } from './clock';
import {
  boundedRing,
  type ConsoleLine,
  MAX_PAGE_ERROR_CHARS,
  type NetworkEntry,
  type PageError,
} from './rings';

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
process.on('unhandledRejection', onUnhandled);
afterEach(() => {
  unhandled.length = 0;
});

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

const failingRequest = (url: string) => ({
  url: () => url,
  resourceType: () => 'document',
  continue: () => Promise.reject(new Error('Protocol error: Target closed')),
  abort: () => Promise.reject(new Error('Protocol error: Target closed')),
});

describe('arm', () => {
  test.each([
    ['an allowed request whose continue() rejects', 'https://allowed.test/'],
    ['a refused request whose abort() rejects', 'https://elsewhere.test/'],
  ])('%s leaves nothing unhandled', async (_label, url) => {
    const { page, fire } = fakePage();
    await arm(
      { page, rules: { allowHosts: ['allowed.test'] }, clock: testScrapeClock() },
      {
        network: boundedRing(),
        console: boundedRing(),
        pageErrors: boundedRing(),
        crashed: { value: undefined },
      },
    );
    fire('request', failingRequest(url));
    await Bun.sleep(5);
    expect(unhandled).toEqual([]);
  });

  // A ring bounds the COUNT; a page controls each entry's SIZE. 200 console lines of a serialised
  // state blob, or 200 `data:` URLs, held the megabytes the ring exists to keep out of the heap.
  test('a console line and a request URL are clamped to the per-entry cap', async () => {
    const { page, fire } = fakePage();
    const sinks = {
      network: boundedRing<NetworkEntry>(),
      console: boundedRing<ConsoleLine>(),
      pageErrors: boundedRing<PageError>(),
      crashed: { value: undefined },
    };
    await arm({ page, rules: { allowHosts: ['allowed.test'] }, clock: testScrapeClock() }, sinks);
    const huge = 'x'.repeat(1_000_000);
    fire('console', { type: () => 'log', text: () => huge });
    const request = (url: string) => ({
      ...failingRequest(url),
      continue: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    });
    fire('request', request(`https://allowed.test/?q=${huge}`));
    fire('request', request(`https://elsewhere.test/?q=${huge}`));
    const [line] = sinks.console.entries();
    expect(line?.text.length).toBe(MAX_PAGE_ERROR_CHARS);
    const urls = sinks.network.entries().map((entry) => entry.url.length);
    expect(urls).toEqual([MAX_PAGE_ERROR_CHARS, MAX_PAGE_ERROR_CHARS]);
    expect(sinks.network.entries()[1]?.refused).toBe('host');
  });
});
