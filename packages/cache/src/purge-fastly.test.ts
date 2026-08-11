// The Fastly transport, asserted over an injected `fetch`: the sealed test network covers real
// egress, and the request itself is the contract here — a wrong URL, a dropped header or a batch
// that silently truncates is a stale edge no later read can catch.

import { describe, expect, test } from 'bun:test';
import { markListening } from '@ultimat3/core';
import { createCdnTier } from './cdn';
import { FASTLY_MAX_KEYS_PER_REQUEST, fastlyPurgeDriver } from './purge-fastly';
import type { PurgeFetch } from './purge-http';
import { tag } from './tags';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

function recorder(reply: (call: Call) => Response = () => json({})): {
  calls: Call[];
  fetch: PurgeFetch;
} {
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
  fastlyPurgeDriver({
    apiToken: 'fastly-token',
    serviceId: 'svc_1',
    baseUrl: 'https://api.fastly.test',
    fetch,
  });

describe('fastlyPurgeDriver construction', () => {
  test('is named "fastly"', () => {
    expect(driverWith(recorder().fetch).name).toBe('fastly');
  });

  // Refused where the env key is still nameable, rather than on the first purge nobody watches.
  test('an unset token refuses at construction, naming the env key', () => {
    const failure = (): unknown => fastlyPurgeDriver({ apiToken: '  ', serviceId: 'svc_1' });
    expect(failure).toThrow(/X_CACHE_DRIVER_UNAVAILABLE/);
    expect(failure).toThrow(/FASTLY_API_TOKEN/);
  });

  test('an unset service id refuses at construction, naming the env key', () => {
    const failure = (): unknown => fastlyPurgeDriver({ apiToken: 'token', serviceId: '' });
    expect(failure).toThrow(/X_CACHE_DRIVER_UNAVAILABLE/);
    expect(failure).toThrow(/FASTLY_SERVICE_ID/);
  });
});

describe('fastlyPurgeDriver.purge', () => {
  test('posts the surrogate keys to the service purge endpoint with the api token', async () => {
    const { calls, fetch } = recorder();

    await driverWith(fetch).purge(['post', 'post:1']);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.fastly.test/service/svc_1/purge');
    expect(new Headers(calls[0]?.init.headers).get('Fastly-Key')).toBe('fastly-token');
    expect(bodyOf(calls[0])).toEqual({ surrogate_keys: ['post', 'post:1'] });
  });

  test('an empty key list sends no request at all', async () => {
    const { calls, fetch } = recorder();
    expect(await driverWith(fetch).purge([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('reports the keys Fastly named in its response', async () => {
    const { fetch } = recorder(() => json({ post: 'purge-id-1' }));
    expect(await driverWith(fetch).purge(['post', 'post:1'])).toEqual(['post']);
  });

  // Fastly answers a single-key purge with `{status, id}` — a shape that names no key. A 2xx is
  // acceptance, so the requested batch is the honest answer rather than "nothing was purged".
  test('a response naming no key still reports the batch as accepted', async () => {
    const { fetch } = recorder(() => json({ status: 'ok', id: '1' }));
    expect(await driverWith(fetch).purge(['post', 'post:1'])).toEqual(['post', 'post:1']);
  });

  test('a non-JSON 2xx body is still acceptance, not a failure', async () => {
    const { fetch } = recorder(() => new Response('ok'));
    expect(await driverWith(fetch).purge(['post'])).toEqual(['post']);
  });

  test('batches at the 256-key API cap and reports every batch as accepted', async () => {
    const keys = Array.from({ length: 600 }, (_, index) => `post:${index}`);
    const { calls, fetch } = recorder();

    const accepted = await driverWith(fetch).purge(keys);

    expect(calls).toHaveLength(3);
    expect(FASTLY_MAX_KEYS_PER_REQUEST).toBe(256);
    const sizes = calls.map((call) => {
      const body = bodyOf(call) as { surrogate_keys: string[] };
      return body.surrogate_keys.length;
    });
    expect(sizes).toEqual([256, 256, 88]);
    expect(accepted).toEqual(keys);
  });

  test('a key a CDN would split is refused before any request leaves', async () => {
    const { calls, fetch } = recorder();
    await expect(driverWith(fetch).purge(['post 1'])).rejects.toThrow(/X_CACHE_PURGE_FAILED/);
    expect(calls).toHaveLength(0);
  });
});

describe('fastlyPurgeDriver failures', () => {
  const failureOf = async (response: Response, keys: readonly string[] = ['post']) => {
    const { fetch } = recorder(() => response);
    return await driverWith(fetch)
      .purge(keys)
      .then(
        () => undefined,
        (error: unknown) =>
          error as { code?: string; cause?: string; fix?: string; meta?: Record<string, unknown> },
      );
  };

  test('a bad credential is not retryable and the fix names the token', async () => {
    const failure = await failureOf(json({ msg: 'Provided credentials are missing' }, 401));
    expect(failure?.code).toBe('X_CACHE_PURGE_FAILED');
    expect(failure?.cause).toContain('HTTP 401');
    expect(failure?.cause).toContain('Provided credentials are missing');
    expect(failure?.meta?.['retryable']).toBe(false);
    expect(failure?.fix).toContain('FASTLY_API_TOKEN');
  });

  test('an unknown service names FASTLY_SERVICE_ID', async () => {
    const failure = await failureOf(json({ msg: 'Record not found' }, 404));
    expect(failure?.fix).toContain('FASTLY_SERVICE_ID');
  });

  test('a throttle and a 5xx are retryable', async () => {
    expect((await failureOf(json({}, 429)))?.meta?.['retryable']).toBe(true);
    expect((await failureOf(json({}, 503)))?.meta?.['retryable']).toBe(true);
  });

  // The gate's `fix:` scanner reads `fix:` properties, so it never sees the literals `fixFor`
  // returns — this test is the whole enforcement. The 429 was "raise the purge rate limit on the
  // Fastly account", which is advice no agent can run; Fastly answers with `Fastly-RateLimit-*`,
  // so the remaining budget is readable and that is what the fix hands over.
  test('every failure fix names a command to run or an env key to edit', async () => {
    for (const status of [401, 403, 404, 429, 500, 503]) {
      const fix = (await failureOf(json({}, status)))?.fix ?? '';
      expect(fix).toMatch(/^curl -sS |\.env\.production/);
    }
    expect((await failureOf(json({}, 429)))?.fix).toContain('fastly-ratelimit');
  });

  test('purgeAll posts purge_all, and its failure is reported the same way', async () => {
    const { calls, fetch } = recorder();
    await driverWith(fetch).purgeAll();
    expect(calls[0]?.url).toBe('https://api.fastly.test/service/svc_1/purge_all');

    const refusing = recorder(() => json({ msg: 'forbidden' }, 403));
    await expect(driverWith(refusing.fetch).purgeAll()).rejects.toThrow(/X_CACHE_PURGE_FAILED/);
  });
});

describe('over a real socket', () => {
  /**
   * Everything above injects `fetch`, which proves the request this driver *builds*. This proves
   * the one it *sends*: the default fetch, a real HTTP round trip, real header casing and a real
   * `Response` parsed back. The loopback server announces itself to core's listener registry, so
   * the sealed test network reads it as this process talking to itself rather than egress.
   */
  test('purges through the default fetch, with the token on the wire', async () => {
    const seen: { path: string; token: string | null; body: string }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        seen.push({
          path: new URL(request.url).pathname,
          token: request.headers.get('Fastly-Key'),
          body: await request.text(),
        });
        return Response.json({ post: 'purge-id-1', 'post:1': 'purge-id-2' });
      },
    });
    const release = markListening(server.url.origin);

    try {
      const driver = fastlyPurgeDriver({
        apiToken: 'live-token',
        serviceId: 'svc_live',
        baseUrl: server.url.origin,
      });

      expect(await driver.purge(['post', 'post:1'])).toEqual(['post', 'post:1']);
      await driver.purgeAll();

      expect(seen.map((request) => request.path)).toEqual([
        '/service/svc_live/purge',
        '/service/svc_live/purge_all',
      ]);
      expect(seen[0]?.token).toBe('live-token');
      expect(seen[0]?.body).toBe('{"surrogate_keys":["post","post:1"]}');
    } finally {
      release();
      await server.stop(true);
    }
  });

  test('a refusal on the wire becomes X_CACHE_PURGE_FAILED, not an unhandled status', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ msg: 'Provided credentials are missing or invalid' }, { status: 401 }),
    });
    const release = markListening(server.url.origin);

    try {
      const driver = fastlyPurgeDriver({
        apiToken: 'wrong',
        serviceId: 'svc_live',
        baseUrl: server.url.origin,
      });
      await expect(driver.purge(['post'])).rejects.toThrow(/X_CACHE_PURGE_FAILED/);
    } finally {
      release();
      await server.stop(true);
    }
  });
});

describe('the cdn tier over a real driver', () => {
  // Surrogate keys ARE the tags: the strings `invalidateTags` fans out are the strings Fastly
  // is asked to purge, byte for byte. A translation step anywhere here is a drift no test could
  // catch later, because the edge would answer 200 for a key nothing was ever tagged with.
  test('the wire tags reach the provider unchanged', async () => {
    const { calls, fetch } = recorder();
    const tier = createCdnTier({ purge: driverWith(fetch) });

    const result = await tier.invalidateTags([tag('post'), tag('post', '1')]);

    expect(bodyOf(calls[0])).toEqual({ surrogate_keys: ['post', 'post:1'] });
    expect(result).toEqual({ tier: 'cdn', keys: ['post', 'post:1'] });
  });
});
