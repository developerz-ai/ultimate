// Single responsibility: the interception handler never floats a rejection. `request.continue()`
// and `request.abort()` reject when the target closed mid-request — and on any other protocol
// error — and `void` left that as an unhandled rejection, which Bun ends the process on.

import { afterEach, describe, expect, test } from 'bun:test';
import { arm } from './cdp-arm';
import type { CdpPageLike } from './cdp-port';
import { testClock } from './clock';
import { createRing } from './rings';

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
      { page, rules: { allowHosts: ['allowed.test'] }, clock: testClock() },
      {
        network: createRing(),
        console: createRing(),
        pageErrors: createRing(),
        crashed: { value: undefined },
      },
    );
    fire('request', failingRequest(url));
    await Bun.sleep(5);
    expect(unhandled).toEqual([]);
  });
});
