// CORS is the one header set where a permissive mistake is invisible from the origin that
// made it and useful to every other one. These tests hold the default shut and pin the two
// ways it quietly widens: a wildcard standing next to credentials, and preflight answering an
// origin the allow-list rejects.
import { describe, expect, test } from 'bun:test';
import {
  BUILD_ID_HEADER,
  clientTransport,
  ctxOf,
  DATES_HEADER,
  type FetchLike,
  IDEMPOTENCY_HEADER,
  RECORDS_HEADER,
  REPLAYED_HEADER,
  REQUEST_TIMEOUT_HEADER,
  renderDeprecation,
  runWithContext,
  withSpan,
} from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { assertCorsConfig, corsHeaders, DEFAULT_CORS, originListed, preflight } from './cors';
import { HttpError } from './errors';
import { rateLimitHeaders } from './rate-limit-headers';

describe('corsHeaders()', () => {
  // A refusal carries `vary: origin` and nothing else. Without the key, a shared cache files the
  // un-CORS'd body under the URL alone and answers the NEXT, allowed, origin out of that slot —
  // a fetch that fails with no header and nothing in the request to explain it.
  test('null origin gets no allow-origin, but is still keyed on the origin', () => {
    expect(corsHeaders({ ...DEFAULT_CORS, origins: ['https://a.test'] }, null)).toEqual({
      vary: 'origin',
    });
  });

  test('origin not in the allow-list and no wildcard gets no allow-origin', () => {
    expect(corsHeaders({ ...DEFAULT_CORS, origins: ['https://a.test'] }, 'https://b.test')).toEqual(
      {
        vary: 'origin',
      },
    );
  });

  test('exact match sets allow-origin and vary', () => {
    const headers = corsHeaders(
      { ...DEFAULT_CORS, origins: ['https://a.test'], credentials: false, exposeHeaders: [] },
      'https://a.test',
    );
    expect(headers['access-control-allow-origin']).toBe('https://a.test');
    expect(headers['vary']).toBe('origin');
  });

  test('access-control-allow-credentials present only when config.credentials is true', () => {
    const withCreds = corsHeaders(
      { ...DEFAULT_CORS, origins: ['https://a.test'], credentials: true },
      'https://a.test',
    );
    expect(withCreds['access-control-allow-credentials']).toBe('true');

    const withoutCreds = corsHeaders(
      { ...DEFAULT_CORS, origins: ['https://a.test'], credentials: false },
      'https://a.test',
    );
    expect(withoutCreds['access-control-allow-credentials']).toBeUndefined();
  });

  test('access-control-expose-headers present only when exposeHeaders is non-empty', () => {
    const withExpose = corsHeaders(
      {
        ...DEFAULT_CORS,
        origins: ['https://a.test'],
        credentials: false,
        exposeHeaders: ['x-request-id', 'retry-after'],
      },
      'https://a.test',
    );
    expect(withExpose['access-control-expose-headers']).toBe('x-request-id, retry-after');

    const withoutExpose = corsHeaders(
      { ...DEFAULT_CORS, origins: ['https://a.test'], credentials: false, exposeHeaders: [] },
      'https://a.test',
    );
    expect(withoutExpose['access-control-expose-headers']).toBeUndefined();
  });

  test('wildcard origin with credentials false allows *', () => {
    const headers = corsHeaders(
      { ...DEFAULT_CORS, origins: ['*'], credentials: false },
      'https://anything.test',
    );
    expect(headers['access-control-allow-origin']).toBe('*');
  });

  test('wildcard origin with credentials true resolves to no allow-origin', () => {
    // A wildcard cannot be combined with credentialed requests, so the wildcard is ignored rather
    // than emitting an invalid `*` + credentials pair — which is why `assertCorsConfig` refuses
    // that pair before a request can reach this.
    const headers = corsHeaders(
      { ...DEFAULT_CORS, origins: ['*'], credentials: true },
      'https://anything.test',
    );
    expect(headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('originListed()', () => {
  // The two questions this file answers are not the same one, and reading the response header as
  // an allowance is what let a credentialed cross-site POST through `checkCsrf`.
  test('the wildcard reads as an allow-origin VALUE, never as a listed origin', () => {
    const wildcard = { ...DEFAULT_CORS, origins: ['*'], credentials: false };
    expect(corsHeaders(wildcard, 'https://evil.test')['access-control-allow-origin']).toBe('*');
    expect(originListed(wildcard, 'https://evil.test')).toBe(false);
  });

  test('an exact listing is what it answers, and a missing origin is never one', () => {
    const config = { ...DEFAULT_CORS, origins: ['https://a.test'] };
    expect(originListed(config, 'https://a.test')).toBe(true);
    expect(originListed(config, 'https://b.test')).toBe(false);
    expect(originListed(config, null)).toBe(false);
  });
});

// `null` is what every sandboxed iframe on the web sends, so allowing it with credentials hands any
// site the reply. It reaches a list by accident: `URL.parse('localhost:3000').origin` is that string.
describe('the opaque origin', () => {
  const listed = { ...DEFAULT_CORS, origins: ['null', 'https://a.test'] };

  test('is refused at the declaration, with or without credentials', () => {
    for (const credentials of [true, false]) {
      let thrown: unknown;
      try {
        assertCorsConfig({ ...listed, credentials });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as HttpError).code).toBe('X_CORS_CONFIG_INVALID');
      expect((thrown as HttpError).cause).toContain("'null'");
    }
  });

  test('is never listed and never answered, if a config reached here unscreened', () => {
    expect(originListed(listed, 'null')).toBe(false);
    const headers = corsHeaders(listed, 'null');
    expect(headers['access-control-allow-origin']).toBeUndefined();
    expect(headers['access-control-allow-credentials']).toBeUndefined();
  });

  test('a real listed origin still answers', () => {
    expect(corsHeaders(listed, 'https://a.test')['access-control-allow-origin']).toBe(
      'https://a.test',
    );
  });

  test("origins: ['*'] without credentials still answers it, as any origin", () => {
    const open = { ...DEFAULT_CORS, origins: ['*'], credentials: false };
    expect(corsHeaders(open, 'null')['access-control-allow-origin']).toBe('*');
  });
});

describe('assertCorsConfig()', () => {
  // `DEFAULT_CORS.credentials` is true, so `origins: ['*']` on its own is the natural "open it up"
  // edit — and it used to resolve to no CORS headers at all, silently, on every request.
  test("refuses '*' next to credentials, at config time, with the edit that fixes it", () => {
    let thrown: unknown;
    try {
      assertCorsConfig({ ...DEFAULT_CORS, origins: ['*'] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).code).toBe('X_CORS_CONFIG_INVALID');
    expect((thrown as HttpError).fix).toContain('credentials: false');
  });

  test('defineHttpConfig is where an app meets that refusal', () => {
    expect(() =>
      defineHttpConfig({ rateLimit: { scope: 'process' }, cors: { origins: ['*'] } }),
    ).toThrow(HttpError);
    // Both legal spellings still resolve.
    expect(
      defineHttpConfig({
        rateLimit: { scope: 'process' },
        cors: { origins: ['*'], credentials: false },
      }).cors.origins,
    ).toEqual(['*']);
    expect(
      defineHttpConfig({ rateLimit: { scope: 'process' }, cors: { origins: ['https://a.test'] } })
        .cors.credentials,
    ).toBe(true);
  });
});

describe('an origin the browser could never send', () => {
  // `originListed` compares bytes. A browser's `Origin` is always the serialised origin, so a
  // listed entry in any other spelling matches nothing: no CORS headers, a 403 preflight and every
  // write refused, with a config that reads as correct. Refused where it is written instead.
  const refusal = (origin: string): HttpError => {
    try {
      assertCorsConfig({ ...DEFAULT_CORS, origins: [origin] });
    } catch (error) {
      if (error instanceof HttpError) return error;
    }
    return expect.unreachable(`${origin} was accepted`);
  };

  test.each([
    ['https://app.com/', 'https://app.com'],
    ['https://App.com', 'https://app.com'],
    ['https://app.com:443', 'https://app.com'],
    ['http://app.com:80/x?y', 'http://app.com'],
  ])('%s is refused, with %s in the fix', (written, canonical) => {
    const error = refusal(written);
    expect(error.code).toBe('X_CORS_CONFIG_INVALID');
    expect(error.fix).toContain(`'${canonical}'`);
  });

  test('a bare host is refused, with the scheme to add in the fix', () => {
    const error = refusal('app.com');
    expect(error.code).toBe('X_CORS_CONFIG_INVALID');
    expect(error.fix).toContain("'https://app.com'");
  });

  test('every canonical spelling, and the wildcard, still pass', () => {
    for (const origins of [
      ['https://app.com', 'http://localhost:3000', 'https://a.test:8443', 'http://[::1]:3000'],
      ['*'],
    ]) {
      expect(() =>
        assertCorsConfig({ ...DEFAULT_CORS, origins, credentials: false }),
      ).not.toThrow();
    }
  });
});

describe('preflight()', () => {
  const config = { ...DEFAULT_CORS, origins: ['https://a.test'] };

  test('non-OPTIONS request returns undefined', () => {
    const request = new Request('http://x/', {
      method: 'GET',
      headers: { origin: 'https://a.test' },
    });
    expect(preflight(request, config)).toBeUndefined();
  });

  test('OPTIONS missing access-control-request-method returns undefined', () => {
    const request = new Request('http://x/', {
      method: 'OPTIONS',
      headers: { origin: 'https://a.test' },
    });
    expect(preflight(request, config)).toBeUndefined();
  });

  test('OPTIONS with disallowed origin is rejected with 403 and no cors headers', () => {
    const request = new Request('http://x/', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' },
    });
    const response = preflight(request, config);
    expect(response?.status).toBe(403);
    expect(response?.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('OPTIONS with allowed origin answers 204 with full preflight headers', () => {
    const request = new Request('http://x/', {
      method: 'OPTIONS',
      headers: { origin: 'https://a.test', 'access-control-request-method': 'POST' },
    });
    const response = preflight(request, config);
    expect(response?.status).toBe(204);
    expect(response?.headers.get('access-control-allow-methods')).toBe(config.methods.join(', '));
    expect(response?.headers.get('access-control-allow-headers')).toBe(
      config.allowHeaders.join(', '),
    );
    expect(response?.headers.get('access-control-max-age')).toBe(String(config.maxAgeSeconds));
    expect(response?.headers.get('access-control-allow-origin')).toBe('https://a.test');
    expect(response?.headers.get('vary')).toBe('origin');
  });
});

describe('DEFAULT_CORS', () => {
  test('locks same-origin by default and ships sane method/header sets', () => {
    expect(DEFAULT_CORS.origins).toEqual([]);
    expect(DEFAULT_CORS.credentials).toBe(true);
    expect(DEFAULT_CORS.methods).toEqual(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
    expect(DEFAULT_CORS.allowHeaders).toEqual([
      'content-type',
      'authorization',
      BUILD_ID_HEADER,
      'x-request-id',
      IDEMPOTENCY_HEADER,
      REQUEST_TIMEOUT_HEADER,
      'traceparent',
    ]);
    expect(DEFAULT_CORS.exposeHeaders).toEqual([
      'x-request-id',
      BUILD_ID_HEADER,
      'retry-after',
      RECORDS_HEADER,
      DATES_HEADER,
      REPLAYED_HEADER,
      'ratelimit-limit',
      'ratelimit-remaining',
      'ratelimit-reset',
      'deprecation',
      'sunset',
      'link',
    ]);
  });

  test('an app list replaces the default whole, it never merges', () => {
    const config = defineHttpConfig({
      dev: false,
      rateLimit: { scope: 'process' },
      cors: { allowHeaders: ['x-mine'], exposeHeaders: ['x-yours'] },
    });
    expect(config.cors.allowHeaders).toEqual(['x-mine']);
    expect(config.cors.exposeHeaders).toEqual(['x-yours']);
  });
});

/** What a browser never preflights, and what it shows a page cross-origin without being told. */
const SAFELISTED_REQUEST = new Set(['accept', 'content-language', 'content-type']);
const SAFELISTED_RESPONSE = new Set(['cache-control', 'content-language', 'content-length']);
const ALSO_SAFELISTED_RESPONSE = ['content-type', 'expires', 'last-modified', 'pragma'];
for (const name of ALSO_SAFELISTED_RESPONSE) SAFELISTED_RESPONSE.add(name);

/**
 * Every header `clientTransport` wrote and read across the paths that differ: a keyed write, a read
 * under a span with a request budget, and a refusal. Observed, never listed: a header the transport
 * starts sending or reading tomorrow fails the two tests below without anyone editing them.
 */
async function transportTraffic(): Promise<{ sent: Set<string>; read: Set<string> }> {
  const sent = new Set<string>();
  const read = new Set<string>();
  const answering =
    (status: number): FetchLike =>
    async (_url, init) => {
      for (const name of Object.keys(init.headers as Record<string, string>)) {
        sent.add(name.toLowerCase());
      }
      const body = status === 200 ? '{}' : '{"code":"X_RATE_LIMITED","cause":"c","fix":"f"}';
      const response = new Response(body, { status });
      const get = response.headers.get.bind(response.headers);
      response.headers.get = (name: string): string | null => {
        read.add(name.toLowerCase());
        return get(name);
      };
      return response;
    };
  const ok = answering(200);
  await clientTransport({
    method: 'POST',
    url: '/api/things',
    body: {},
    idempotencyKey: 'k',
    fetchImpl: ok,
  });
  const budgeted = ctxOf({ deadlineAt: Date.now() + 60_000 });
  await runWithContext(budgeted, () =>
    withSpan('cors.test', () => clientTransport({ method: 'GET', url: '/q', fetchImpl: ok })),
  );
  await clientTransport({ method: 'GET', url: '/q', fetchImpl: answering(429) }).catch(() => null);
  return { sent, read };
}

describe('the default against what the clients do on the wire', () => {
  test('every header clientTransport sends is allowed', async () => {
    const { sent } = await transportTraffic();
    // The walk reached the conditional ones, so this cannot pass by observing nothing.
    expect([...sent]).toEqual(
      expect.arrayContaining([IDEMPOTENCY_HEADER, REQUEST_TIMEOUT_HEADER, 'traceparent']),
    );
    for (const name of sent) {
      if (!SAFELISTED_REQUEST.has(name)) expect(DEFAULT_CORS.allowHeaders).toContain(name);
    }
  });

  test('the headers only the typed client adds are allowed and exposed', () => {
    expect(DEFAULT_CORS.allowHeaders).toContain(BUILD_ID_HEADER);
    expect(DEFAULT_CORS.exposeHeaders).toContain(BUILD_ID_HEADER);
  });

  test('every header clientTransport reads is exposed', async () => {
    const { read } = await transportTraffic();
    expect([...read]).toEqual(
      expect.arrayContaining([RECORDS_HEADER, DATES_HEADER, 'retry-after']),
    );
    // `date` alone is tolerated hidden: it only dates an HTTP-date `Retry-After`, and this server
    // writes delta-seconds (`retryAfterOf`). `retryAfterSecondsOf` documents the unexposed case.
    read.delete('date');
    for (const name of read) {
      if (!SAFELISTED_RESPONSE.has(name)) expect(DEFAULT_CORS.exposeHeaders).toContain(name);
    }
  });

  test('every header the server writes for a client to act on is exposed', () => {
    const decision = { allowed: true, limit: 1, remaining: 1, resetAtMs: 0, retryAfterSeconds: 0 };
    const window = { since: '2026-01-01T00:00:00Z', sunset: '2027-01-01T00:00:00Z' };
    const rendered = renderDeprecation(window, '/api/next');
    if (!rendered.ok) return expect.unreachable('the fixture window is a real date');
    for (const name of [
      ...Object.keys(rateLimitHeaders(decision, 0)),
      ...Object.keys(rendered.headers),
      REPLAYED_HEADER,
    ]) {
      expect(DEFAULT_CORS.exposeHeaders).toContain(name);
    }
  });

  test('a keyed write from a listed origin passes preflight', () => {
    const origin = 'https://a.test';
    const response = preflight(
      new Request('https://app.test/api/things', {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': IDEMPOTENCY_HEADER,
        },
      }),
      { ...DEFAULT_CORS, origins: [origin] },
    );
    expect(response?.status).toBe(204);
    expect(response?.headers.get('access-control-allow-headers')).toContain(IDEMPOTENCY_HEADER);
  });

  /** The answer as a browser hands it to a page: only what the CORS reply let through. */
  const asTheBrowserShows = (expose: readonly string[]): FetchLike => {
    const config = { ...DEFAULT_CORS, origins: ['https://a.test'], exposeHeaders: [...expose] };
    const exposed = corsHeaders(config, 'https://a.test')['access-control-expose-headers'];
    const visible = new Set((exposed ?? '').split(', '));
    return async () => {
      const answer: Record<string, string> = { [RECORDS_HEADER]: '1', 'content-type': 'text/json' };
      const shown = Object.entries(answer).filter(
        ([name]) => visible.has(name) || SAFELISTED_RESPONSE.has(name),
      );
      return new Response('{"data":{"id":1},"records":{}}', {
        headers: Object.fromEntries(shown),
      });
    };
  };

  test('a typed call from a listed origin answers the output, not the envelope', async () => {
    const call = (fetchImpl: FetchLike) =>
      clientTransport({ method: 'POST', url: '/api/things', body: {}, fetchImpl });
    // The control is the defect: with the records header hidden, the envelope IS the answer.
    expect(await call(asTheBrowserShows(['retry-after']))).toEqual({
      data: { id: 1 },
      records: {},
    });
    expect(await call(asTheBrowserShows(DEFAULT_CORS.exposeHeaders))).toEqual({ id: 1 });
  });
});
