// The offline HTTP leg applies the same gates as the live one. Both of them: a rule only the live
// transport enforces is a rule a green suite cannot see, and the first attempt that meets it is a
// production one.

import { describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { testClock } from './clock';
import { fakeBrowser } from './driver-fake';
import { recordedHttp } from './http-recorded';
import type { HttpRecording } from './recording';
import type { NetworkEntry } from './rings';
import { createRing } from './rings';
import { createRobotsGate } from './robots';
import { createSecretBag, SECRET_PLACEHOLDER } from './secrets';

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

/**
 * Through `fakeBrowser().open()` and not `recordedHttp()` directly, deliberately: what is under
 * test is `offline-session.ts` HANDING the run's secret bag to the second leg. Wired only on the
 * live leg, the redaction would be one no fixture could ever prove.
 */
describe('unit · the recorded leg redacts the same body the live leg does', () => {
  const SECRET = 'hunter2-the-password';

  test('a recorded 4xx that echoes the password does not reach the error cause', async () => {
    const session = await fakeBrowser([], {
      http: [
        {
          url: 'https://shop.test/login',
          method: 'GET',
          status: 401,
          body: `{"error":"wrong password: ${SECRET}"}`,
        },
      ],
    }).open({
      name: 'orders',
      rules: { allowHosts: ['shop.test'] },
      clock: testClock(),
      timeoutMs: 1_000,
      secrets: createSecretBag(['SHOP_PASSWORD'], () => SECRET),
    });
    try {
      const response = await session.http.request('https://shop.test/login');
      let cause = '';
      try {
        await response.parse(t.object({ ok: t.boolean }));
      } catch (thrown) {
        const error = thrown as { cause?: unknown };
        cause = typeof error.cause === 'string' ? error.cause : '';
      }
      expect(cause).not.toContain(SECRET);
      expect(cause).toContain(SECRET_PLACEHOLDER);
    } finally {
      await session.close();
    }
  });
});
