// The shared HTTP half is where both drivers agree on what a failure means. Every assertion here
// is a decision a purge cannot get wrong twice: a key a CDN would split, a body read twice, and
// which status is worth sending the identical request for again.

import { describe, expect, test } from 'bun:test';
import type { UltimateError } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import { CacheDriverUnavailableError } from './errors';
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

/**
 * The thrown error itself, so a test asserts on `code` and `cause` together. Anything else — no
 * throw, or a throw carrying neither — fails through the runner with `expect.unreachable` rather
 * than a bare `Error`, which would report a stack from inside this helper and no code at all.
 */
function refusalOf(call: () => unknown): UltimateError {
  try {
    call();
  } catch (error) {
    if (isUltimateError(error)) return error;
  }
  return expect.unreachable('expected a typed cache refusal');
}

describe('chunked', () => {
  test('splits into batches of at most size, in order', () => {
    expect(chunked('fastly', [1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test('an exact multiple leaves no trailing empty batch', () => {
    expect(chunked('fastly', [1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test('an empty list is no batches, so a caller sends no request', () => {
    expect(chunked('cloudflare', [], 30)).toEqual([]);
  });

  // A size of 0 or less never advances the index: the loop spins forever, holding open the write's
  // own invalidation. Refused before the first iteration, so there is no loop to hang in.
  test('a batch size of 0 or -1 is refused instead of looping forever', () => {
    for (const size of [0, -1]) {
      const failure = refusalOf(() => chunked('fastly', ['post', 'feed'], size));
      expect(failure.code).toBe('X_CACHE_DRIVER_UNAVAILABLE');
      expect(failure.cause).toContain(`batch size ${size}`);
      expect(failure.fix).toContain('chunked(');
    }
  });

  // NaN fails every comparison, so `index += NaN` ends the loop after one pass and that pass slices
  // to NaN: one empty batch. The driver posts an empty key list, the CDN answers 200, and the purge
  // reports having cleared nothing — the one CDN failure no later read can catch.
  test('a NaN batch size is refused rather than silently purging nothing', () => {
    const failure = refusalOf(() => chunked('cloudflare', ['post', 'feed'], Number.NaN));
    expect(failure.code).toBe('X_CACHE_DRIVER_UNAVAILABLE');
    expect(failure.cause).toContain('NaN');
    expect(failure.cause).toContain('cloudflare');
  });

  test('a fractional or infinite size is refused too — no provider caps keys at either', () => {
    expect(refusalOf(() => chunked('fastly', ['post'], 2.5)).code).toBe(
      'X_CACHE_DRIVER_UNAVAILABLE',
    );
    expect(refusalOf(() => chunked('fastly', ['post'], Number.POSITIVE_INFINITY)).code).toBe(
      'X_CACHE_DRIVER_UNAVAILABLE',
    );
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

  /**
   * The limit is BYTES and the guard counted UTF-16 code units, so 900 CJK characters — 2700 bytes
   * on the wire — passed a check whose own message said "over the 1024-byte key limit". The CDN
   * then refuses or truncates the header, which is the accepted-purge-that-cleared-nothing this
   * function exists to prevent.
   */
  test('measures the key in BYTES, not characters', () => {
    const key = '\u4e2d'.repeat(900);
    expect(key.length).toBeLessThan(1024);
    expect(new TextEncoder().encode(key).byteLength).toBeGreaterThan(1024);
    const failure = refusalOf(() => {
      assertPurgeableKeys('fastly', [key]);
    });
    expect(failure.code).toBe('X_CACHE_PURGE_FAILED');
    expect(failure.cause).toContain('2700 bytes');
  });

  test('a multi-byte key that fits in bytes is still accepted', () => {
    // 340 three-byte characters is 1020 bytes: under the limit on the wire, so not this guard's.
    expect(() => assertPurgeableKeys('fastly', ['\u4e2d'.repeat(340)])).not.toThrow();
  });

  test('the refusal is not retryable — the same key would fail identically', () => {
    const failure = refusalOf(() => {
      assertPurgeableKeys('fastly', ['post 1']);
    });
    expect(failure.code).toBe('X_CACHE_PURGE_FAILED');
    expect(failure.meta?.['retryable']).toBe(false);
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
      // A coded transport failure, not a bare `Error`: `purgePost` reads `error.message` for its
      // own cause, so the code and the reason both have to survive into the reported detail.
      fetch: () =>
        Promise.reject(
          new CacheDriverUnavailableError({
            driver: 'cloudflare',
            cause: 'ECONNREFUSED reaching api.cloudflare.test from this host',
            fix: 'curl -sS -m 5 -o /dev/null https://api.cloudflare.com/client/v4',
          }),
        ),
    }).then(
      () => undefined,
      (error: unknown) =>
        error as { code?: string; cause?: string; fix?: string; meta?: { retryable?: boolean } },
    );

    expect(failure?.code).toBe('X_CACHE_PURGE_FAILED');
    expect(failure?.meta?.retryable).toBe(true);
    expect(failure?.fix).toBe('curl -sS -m 5 -o /dev/null https://cdn.test/purge');
    expect(failure?.cause).toContain('ECONNREFUSED');
  });

  test('a rejection that fights being read is still a coded purge failure', async () => {
    // `fetch` is INJECTED, so the rejected value is whatever a driver or an app-supplied double
    // threw. `error instanceof Error` runs the proxy's `getPrototypeOf` trap, so the guard itself
    // threw and the catch that exists to CODE this failure raised a bare `TypeError` out of the
    // purge instead — no code, no `retryable`, no probe to run. `renderThrowable` is the renderer
    // that cannot itself throw, which is why `@ultimat3/cache` allows no other.
    const hostile = new Proxy(new Error('ECONNRESET'), {
      getPrototypeOf(): never {
        throw new TypeError('this value refuses to be identified');
      },
    });

    const failure = await purgePost({
      driver: 'cloudflare',
      url: 'https://cdn.test/purge',
      headers: {},
      body: {},
      timeoutMs: 10,
      fetch: () => Promise.reject(hostile),
    }).then(
      () => undefined,
      (error: unknown) =>
        error as { code?: string; cause?: string; fix?: string; meta?: { retryable?: boolean } },
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
