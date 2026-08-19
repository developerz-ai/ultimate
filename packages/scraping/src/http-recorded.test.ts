// The offline HTTP leg applies the same gates as the live one. Both of them: a rule only the live
// transport enforces is a rule a green suite cannot see, and the first attempt that meets it is a
// production one.

import { describe, expect, test } from 'bun:test';
import { testClock } from './clock';
import { recordedHttp } from './http-recorded';
import type { HttpRecording } from './recording';
import type { NetworkEntry } from './rings';
import { createRing } from './rings';
import { createRobotsGate } from './robots';

const ROBOTS = 'User-agent: *\nDisallow: /api/private\n';

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

const recordings: readonly HttpRecording[] = [
  { url: 'https://shop.test/api/private/orders', method: 'GET', status: 200, body: '{}' },
  { url: 'https://shop.test/api/public/orders', method: 'GET', status: 200, body: '{}' },
];

const offline = (robots = true) =>
  recordedHttp({
    lookup: (method, url) =>
      Promise.resolve(recordings.find((r) => r.method === method && r.url === url)),
    rules: { allowHosts: ['shop.test'] },
    network: createRing<NetworkEntry>(),
    clock: testClock(),
    source: 'test',
    ...(robots
      ? {
          robots: createRobotsGate({
            policy: 'obey',
            // Never the network, ever: an offline transport that fetched robots.txt for real would
            // make a green suite secretly live, which is the rule this file exists for.
            fetchText: () => Promise.resolve(ROBOTS),
          }),
        }
      : {}),
  });

describe('unit · robots.txt gates the replayed HTTP leg, not just the live one', () => {
  test('a Disallow:ed endpoint is refused offline, where the test can see it', async () => {
    expect(await codeOf(offline().request('https://shop.test/api/private/orders'))).toBe(
      'X_SCRAPE_ROBOTS_DISALLOWED',
    );
  });

  test('an allowed endpoint still replays', async () => {
    const response = await offline().request('https://shop.test/api/public/orders');
    expect(response.status).toBe(200);
  });

  test('no gate declared is no gate applied — the offline drivers stay usable bare', async () => {
    const response = await offline(false).request('https://shop.test/api/private/orders');
    expect(response.status).toBe(200);
  });

  test('the host rule is still checked FIRST — the cheaper refusal keeps its meaning', async () => {
    expect(await codeOf(offline().request('https://evil.test/api/private/orders'))).toBe(
      'X_SCRAPE_HOST_BLOCKED',
    );
  });
});
