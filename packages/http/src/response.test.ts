import { describe, expect, test } from 'bun:test';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { bodyInvalid } from './errors';
import {
  applyCacheHeaders,
  cacheControl,
  json,
  noContent,
  problem,
  redirect,
  text,
} from './response';

describe('constructors', () => {
  test('json and text set a charset', async () => {
    const response = json({ ok: true });
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ ok: true });
    expect(text('hi').headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  test('noContent and redirect have no body', () => {
    expect(noContent().status).toBe(204);
    const moved = redirect('/login', 303);
    expect(moved.status).toBe(303);
    expect(moved.headers.get('location')).toBe('/login');
  });
});

describe('problem()', () => {
  test('renders an UltimateError as application/problem+json with code/cause/fix/docs', async () => {
    const response = problem(bodyInvalid('/posts', ['title: required']), {
      instance: '/posts',
      requestId: 'req-7',
    });

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body['code']).toBe('X_BODY_INVALID');
    expect(body['cause']).toContain('title: required');
    expect(body['fix']).toBe(
      'x routes --json   # find /posts, then send a body matching its input schema',
    );
    expect(body['docs']).toBe(ERROR_DOCS_URL);
    expect(body['status']).toBe(422);
    expect(body['instance']).toBe('/posts');
    expect(body['requestId']).toBe('req-7');
  });

  test('extra headers are merged (Retry-After for a limited request)', () => {
    const response = problem(bodyInvalid('/x', ['bad']), { headers: { 'retry-after': '30' } });
    expect(response.headers.get('retry-after')).toBe('30');
  });
});

describe('cache headers', () => {
  test('directives per mode', () => {
    expect(cacheControl({ mode: 'no-store' })).toBe('no-store');
    expect(cacheControl({ mode: 'private', maxAgeSeconds: 30 })).toBe('private, max-age=30');
    expect(
      cacheControl({
        mode: 'public',
        maxAgeSeconds: 0,
        sMaxAgeSeconds: 60,
        staleWhileRevalidateSeconds: 600,
      }),
    ).toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=600');
    expect(cacheControl({ mode: 'immutable', maxAgeSeconds: 100 })).toBe(
      'public, max-age=100, immutable',
    );
  });

  test('tags travel with the response so a purge can target them', () => {
    const response = applyCacheHeaders(text('body'), {
      mode: 'public',
      sMaxAgeSeconds: 10,
      tags: ['post:1', 'feed'],
    });
    expect(response.headers.get('x-cache-tags')).toBe('post:1,feed');
    // Every ambient input a server render reads, in `SHARED_CACHE_VARY`'s own order: `ctx.tz`
    // comes off a header too, and a date formatted in it is as visitor-specific as the locale.
    expect(response.headers.get('vary')).toBe('accept-language, cookie, x-timezone');
  });

  // Without `cookie` in the key, a shared cache stores one visitor's signed-in render of a public
  // page under the URL alone and hands it to the next visitor.
  test('a shared-cacheable response is keyed on the cookie by default', () => {
    const response = applyCacheHeaders(text('body'), { mode: 'public', sMaxAgeSeconds: 60 });
    expect(response.headers.get('vary')?.split(', ')).toContain('cookie');
  });

  test("an explicit vary is the caller's to own, and private needs no cookie key", () => {
    expect(
      applyCacheHeaders(text('body'), { mode: 'public', vary: ['accept'] }).headers.get('vary'),
    ).toBe('accept');
    expect(
      applyCacheHeaders(text('body'), { mode: 'private', maxAgeSeconds: 0 }).headers.get('vary'),
    ).toBeNull();
  });
});

/**
 * A `cache-control` age is RFC-9111 delta-seconds: `1*DIGIT`. `max-age=NaN` is not a smaller age
 * and not a bigger one — it is an unparseable directive, and a conforming cache IGNORES a
 * directive it cannot parse, so the response silently falls back to HEURISTIC caching instead of
 * the age the hint declared. `??` guards nullish and `NaN` is not nullish, so a hint computed from
 * a timestamp difference or read from an env value arrives here intact.
 *
 * This runs on the response path, so the repair is TOTAL rather than a throw: a bad cache hint
 * must not become a 500.
 */
describe('cacheControl never emits a directive a cache cannot parse', () => {
  const AGE = /^[a-z-]+(?:=\d+)?(?:, [a-z-]+(?:=\d+)?)*$/;

  test('a NaN max-age becomes the safe age, never the token NaN', () => {
    const value = cacheControl({ mode: 'public', maxAgeSeconds: Number.NaN });
    expect(value).toMatch(AGE);
    expect(value).toContain('max-age=0');
  });

  test('a NaN s-maxage is dropped, so the shared cache falls back to max-age', () => {
    const value = cacheControl({
      mode: 'public',
      maxAgeSeconds: 0,
      sMaxAgeSeconds: Number.NaN,
      staleWhileRevalidateSeconds: 600,
    });
    expect(value).toMatch(AGE);
    expect(value).not.toContain('s-maxage');
    expect(value).toContain('stale-while-revalidate=600');
  });

  test('a NaN stale-while-revalidate is dropped rather than emitted', () => {
    const value = cacheControl({
      mode: 'public',
      maxAgeSeconds: 30,
      staleWhileRevalidateSeconds: Number.NaN,
    });
    expect(value).toBe('public, max-age=30');
  });

  test('an immutable hint with a non-finite age revalidates rather than guessing a year', () => {
    const value = cacheControl({ mode: 'immutable', maxAgeSeconds: Number.POSITIVE_INFINITY });
    expect(value).toMatch(AGE);
    expect(value).toBe('public, max-age=0, immutable');
  });

  test('a negative or fractional age is a directive too, and is refused the same way', () => {
    expect(cacheControl({ mode: 'private', maxAgeSeconds: -1 })).toBe('private, max-age=0');
    expect(cacheControl({ mode: 'private', maxAgeSeconds: 1.5 })).toBe('private, max-age=0');
  });

  test('the response that carries it is still built, never a 500', () => {
    const response = applyCacheHeaders(text('body'), {
      mode: 'public',
      maxAgeSeconds: Number.NaN,
    });
    expect(response.headers.get('cache-control')).toMatch(AGE);
  });
});
