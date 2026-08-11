// The shared HTTP half is where both drivers agree on what a failure means. Every assertion here
// is a decision a purge cannot get wrong twice: a key a CDN would split, a body read twice, and
// which status is worth sending the identical request for again.

import { describe, expect, test } from 'bun:test';
import {
  assertPurgeableKeys,
  chunked,
  defaultPurgeFetch,
  detailFrom,
  isRecord,
  isRetryableStatus,
  purgeBody,
  purgePost,
} from './purge-http';

describe('chunked', () => {
  test('splits into batches of at most size, in order', () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test('an exact multiple leaves no trailing empty batch', () => {
    expect(chunked([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test('an empty list is no batches, so a caller sends no request', () => {
    expect(chunked([], 30)).toEqual([]);
  });
});

describe('isRetryableStatus', () => {
  test('a throttle or a momentary conflict can land unchanged', () => {
    for (const status of [408, 409, 425, 429, 500, 502, 503]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  test('a credential, a plan or a wrong id cannot be fixed by retrying', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe('assertPurgeableKeys', () => {
  test('accepts the wire tags the framework actually mints', () => {
    expect(() => {
      assertPurgeableKeys('fastly', ['post', 'post:1', 'feed', 'org:9f3b-1']);
    }).not.toThrow();
  });

  // The failure this guard exists for: a CDN splits a key list on whitespace and commas, so a key
  // carrying either purges two keys that do not exist — and answers 200 while doing it.
  test('refuses a key a CDN would split, naming the key', () => {
    const failure = (): unknown => assertPurgeableKeys('cloudflare', ['post 1']);
    expect(failure).toThrow(/X_CACHE_PURGE_FAILED/);
    expect(failure).toThrow(/post 1/);
  });

  test('refuses a comma, an empty key, and a key over the 1024-byte limit', () => {
    expect(() => assertPurgeableKeys('fastly', ['a,b'])).toThrow(/X_CACHE_PURGE_FAILED/);
    expect(() => assertPurgeableKeys('fastly', [''])).toThrow(/X_CACHE_PURGE_FAILED/);
    expect(() => assertPurgeableKeys('fastly', ['x'.repeat(1025)])).toThrow(/X_CACHE_PURGE_FAILED/);
  });

  test('the refusal is not retryable — the same key would fail identically', () => {
    try {
      assertPurgeableKeys('fastly', ['post 1']);
      throw new Error('expected assertPurgeableKeys to refuse');
    } catch (error) {
      expect((error as { meta?: { retryable?: boolean } }).meta?.retryable).toBe(false);
    }
  });
});

describe('purgeBody', () => {
  test('parses JSON once and keeps the text beside it', async () => {
    const body = await purgeBody(new Response('{"success":true}'));
    expect(body.json).toEqual({ success: true });
    expect(body.text).toBe('{"success":true}');
  });

  // A `Response` streams: the failure path reads the body for its detail, and a second read
  // would throw "Body already used" and lose the message it exists to report.
  test('a non-JSON error page degrades to text rather than throwing', async () => {
    const body = await purgeBody(new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    expect(body.json).toBeUndefined();
    expect(detailFrom(body)).toBe('<html>502 Bad Gateway</html>');
  });

  test('an empty body says so instead of rendering an empty detail', async () => {
    expect(detailFrom(await purgeBody(new Response('')))).toBe('the response body was empty');
  });

  test('a huge body is truncated so one error cannot flood a log line', async () => {
    const detail = detailFrom(await purgeBody(new Response('x'.repeat(5000))));
    expect(detail.length).toBeLessThan(300);
    expect(detail.endsWith('…')).toBe(true);
  });
});

describe('isRecord', () => {
  test('an object is a record; an array, null and a primitive are not', () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([1])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('post')).toBe(false);
  });
});

describe('purgePost', () => {
  test('sends JSON with the driver headers and the caller deadline', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await purgePost({
      driver: 'fastly',
      url: 'https://cdn.test/purge',
      headers: { 'Fastly-Key': 'token' },
      body: { surrogate_keys: ['post'] },
      timeoutMs: 5000,
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(new Response('{}'));
      },
    });

    const [call] = calls;
    expect(call?.url).toBe('https://cdn.test/purge');
    expect(call?.init.method).toBe('POST');
    expect(new Headers(call?.init.headers).get('Fastly-Key')).toBe('token');
    expect(new Headers(call?.init.headers).get('Content-Type')).toBe('application/json');
    expect(call?.init.body).toBe('{"surrogate_keys":["post"]}');
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  // Nothing at the edge saw this request, so the identical one can still land: that is the whole
  // difference between a transport failure and a refusal, and it is why `retryable` is not a guess.
  test('a request that never got a status is retryable and the fix is a reachability probe', async () => {
    const failure = await purgePost({
      driver: 'cloudflare',
      url: 'https://cdn.test/purge',
      headers: {},
      body: {},
      timeoutMs: 10,
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    }).then(
      () => undefined,
      (error: unknown) => error as { code?: string; fix?: string; meta?: { retryable?: boolean } },
    );

    expect(failure?.code).toBe('X_CACHE_PURGE_FAILED');
    expect(failure?.meta?.retryable).toBe(true);
    expect(failure?.fix).toBe('curl -sS -m 5 -o /dev/null https://cdn.test/purge');
  });
});

describe('defaultPurgeFetch', () => {
  // A bare `globalThis.fetch` reference throws "Illegal invocation" on some hosts; this is the
  // assertion that keeps the call detached from a receiver rather than aliased to one.
  test('is a plain function, not a bound reference to the global', () => {
    expect(typeof defaultPurgeFetch).toBe('function');
    expect(defaultPurgeFetch).not.toBe(globalThis.fetch);
  });
});
