// CORS is the one header set where a permissive mistake is invisible from the origin that
// made it and useful to every other one. These tests hold the default shut and pin the two
// ways it quietly widens: a wildcard standing next to credentials, and preflight answering an
// origin the allow-list rejects.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { assertCorsConfig, corsHeaders, DEFAULT_CORS, preflight } from './cors';
import { HttpError } from './errors';

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
      'x-ultimate-build',
      'x-request-id',
    ]);
    expect(DEFAULT_CORS.exposeHeaders).toEqual(['x-request-id', 'x-ultimate-build', 'retry-after']);
    expect(DEFAULT_CORS.methods.length).toBeGreaterThan(0);
    expect(DEFAULT_CORS.allowHeaders.length).toBeGreaterThan(0);
    expect(DEFAULT_CORS.exposeHeaders.length).toBeGreaterThan(0);
  });
});
