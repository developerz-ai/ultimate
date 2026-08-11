// The Cloudflare transport, asserted over an injected `fetch`. The load-bearing case is the one
// `response.ok` cannot see: Cloudflare refuses a purge with HTTP 200 and `"success": false`, and
// reading that as a completed purge leaves the zone stale with no failure recorded anywhere.

import { describe, expect, test } from 'bun:test';
import { CLOUDFLARE_MAX_TAGS_PER_REQUEST, cloudflarePurgeDriver } from './purge-cloudflare';
import type { PurgeFetch } from './purge-http';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

const ok = (): Response => json({ success: true, errors: [], result: { id: 'zone_1' } });

function recorder(reply: (call: Call) => Response = ok): { calls: Call[]; fetch: PurgeFetch } {
  const calls: Call[] = [];
  const fetch: PurgeFetch = (url, init) => {
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(reply(call));
  };
  return { calls, fetch };
}

const bodyOf = (call: Call | undefined): unknown => JSON.parse(String(call?.init.body));

const driverWith = (fetch: PurgeFetch) =>
  cloudflarePurgeDriver({
    apiToken: 'cf-token',
    zoneId: 'zone_1',
    baseUrl: 'https://api.cloudflare.test/client/v4',
    fetch,
  });

const failureOf = async (
  response: Response,
  keys: readonly string[] = ['post'],
): Promise<{ code?: string; cause?: string; fix?: string; meta?: Record<string, unknown> }> => {
  const { fetch } = recorder(() => response);
  const failure = await driverWith(fetch)
    .purge(keys)
    .then(
      () => undefined,
      (error: unknown) =>
        error as { code?: string; cause?: string; meta?: Record<string, unknown> },
    );
  // `expect.unreachable`, never a bare `Error`: a purge that was accepted when the test expected a
  // refusal is reported as the assertion failure it is, with no code-less throw in the way.
  if (failure === undefined) return expect.unreachable('expected the purge to be refused');
  return failure;
};

describe('cloudflarePurgeDriver construction', () => {
  test('is named "cloudflare"', () => {
    expect(driverWith(recorder().fetch).name).toBe('cloudflare');
  });

  test('an unset token or zone refuses at construction, naming the env key', () => {
    expect(() => cloudflarePurgeDriver({ apiToken: '', zoneId: 'zone_1' })).toThrow(
      /CLOUDFLARE_API_TOKEN/,
    );
    expect(() => cloudflarePurgeDriver({ apiToken: 'token', zoneId: '  ' })).toThrow(
      /CLOUDFLARE_ZONE_ID/,
    );
  });
});

describe('cloudflarePurgeDriver.purge', () => {
  test('posts the tags to the zone purge endpoint as a bearer token', async () => {
    const { calls, fetch } = recorder();

    const accepted = await driverWith(fetch).purge(['post', 'post:1']);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.cloudflare.test/client/v4/zones/zone_1/purge_cache');
    expect(new Headers(calls[0]?.init.headers).get('Authorization')).toBe('Bearer cf-token');
    expect(bodyOf(calls[0])).toEqual({ tags: ['post', 'post:1'] });
    expect(accepted).toEqual(['post', 'post:1']);
  });

  test('an empty tag list sends no request at all', async () => {
    const { calls, fetch } = recorder();
    expect(await driverWith(fetch).purge([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('batches at the 30-tag API cap', async () => {
    const keys = Array.from({ length: 65 }, (_, index) => `post:${index}`);
    const { calls, fetch } = recorder();

    const accepted = await driverWith(fetch).purge(keys);

    expect(CLOUDFLARE_MAX_TAGS_PER_REQUEST).toBe(30);
    expect(calls.map((call) => (bodyOf(call) as { tags: string[] }).tags.length)).toEqual([
      30, 30, 5,
    ]);
    expect(accepted).toEqual(keys);
  });

  test('a key a CDN would split is refused before any request leaves', async () => {
    const { calls, fetch } = recorder();
    await expect(driverWith(fetch).purge(['post,feed'])).rejects.toThrow(/X_CACHE_PURGE_FAILED/);
    expect(calls).toHaveLength(0);
  });

  // The whole reason this driver reads the body on the success path too.
  test('HTTP 200 with success:false is a refusal, not a purge', async () => {
    const failure = await failureOf(
      json({ success: false, errors: [{ code: 1122, message: 'Rate limited' }] }),
    );

    expect(failure.code).toBe('X_CACHE_PURGE_FAILED');
    expect(failure.cause).toContain('Rate limited');
    expect(failure.meta?.['retryable']).toBe(false);
  });

  test('a 200 with success:false and no message still says what happened', async () => {
    const failure = await failureOf(json({ success: false }));
    expect(failure.cause).toContain('success: false');
  });

  test('a later batch failing rejects the whole purge rather than reporting it accepted', async () => {
    const keys = Array.from({ length: 35 }, (_, index) => `post:${index}`);
    let sent = 0;
    const { fetch } = recorder(() => {
      sent += 1;
      return sent === 1 ? ok() : json({ success: false, errors: [{ message: 'nope' }] });
    });

    await expect(driverWith(fetch).purge(keys)).rejects.toThrow(/X_CACHE_PURGE_FAILED/);
  });
});

describe('cloudflarePurgeDriver failures', () => {
  test('a bad token is not retryable and the fix names the permission', async () => {
    const failure = await failureOf(
      json({ success: false, errors: [{ message: 'bad token' }] }, 403),
    );
    expect(failure.cause).toContain('HTTP 403');
    expect(failure.cause).toContain('bad token');
    expect(failure.meta?.['retryable']).toBe(false);
    expect(failure.fix).toContain('Cache Purge');
  });

  // Purge-by-tag is an Enterprise feature; a zone without it answers 400 forever, so the fix has
  // to name the plan rather than send an agent round the retry loop.
  test('a 400 names the plan the feature needs', async () => {
    const failure = await failureOf(
      json({ success: false, errors: [{ message: 'not allowed' }] }, 400),
    );
    expect(failure.fix).toContain('Enterprise');
  });

  test('a throttle and a 5xx are retryable', async () => {
    expect((await failureOf(json({}, 429))).meta?.['retryable']).toBe(true);
    expect((await failureOf(json({}, 502))).meta?.['retryable']).toBe(true);
  });

  // The gate's `fix:` scanner reads `fix:` properties, so it never sees the literals `fixFor`
  // returns — this test is the whole enforcement. The 429 was "bust fewer tags per write", which
  // names nothing to open: the zone ceiling is not raisable from here, so the fix names the one
  // lever that exists, the `invalidates` list deciding how many 30-tag requests a write sends.
  test('every failure fix names a command, an env key or the call to narrow', async () => {
    for (const status of [400, 401, 403, 404, 429, 502]) {
      const fix = (await failureOf(json({}, status))).fix ?? '';
      expect(fix).toMatch(/^curl -sS |\.env\.production|\btag\(/);
    }
    const throttled = (await failureOf(json({}, 429))).fix ?? '';
    expect(throttled).toContain('cache.invalidates');
    expect(throttled).toContain('tag(');
  });

  test('an html error page is reported as text rather than swallowed', async () => {
    const failure = await failureOf(new Response('<html>bad gateway</html>', { status: 502 }));
    expect(failure.cause).toContain('bad gateway');
  });
});

describe('cloudflarePurgeDriver.purgeAll', () => {
  test('purges the whole zone through the same endpoint', async () => {
    const { calls, fetch } = recorder();

    await driverWith(fetch).purgeAll();

    expect(calls[0]?.url).toBe('https://api.cloudflare.test/client/v4/zones/zone_1/purge_cache');
    expect(bodyOf(calls[0])).toEqual({ purge_everything: true });
  });

  test('a refused purge_everything throws rather than resolving quietly', async () => {
    const { fetch } = recorder(() => json({ success: false, errors: [{ message: 'nope' }] }));
    await expect(driverWith(fetch).purgeAll()).rejects.toThrow(/X_CACHE_PURGE_FAILED/);
  });
});
