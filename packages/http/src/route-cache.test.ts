// `Route.cache` is a DECLARATION, and this is the screen it gets there. The response path
// (`cacheControl`) is total and drops a field it cannot emit — correct for a hot path, and the
// reason a bad hint used to surface only as a log line, once per request, forever.

import { describe, expect, test } from 'bun:test';
import { anonymousActor } from '@ultimat3/core';
import { defaultCache, PRIVATE_CACHE } from './cache-policy';
import type { CacheHint } from './response';
import { text } from './response';
import { createRouter, type Route } from './router';

const withCache = (cache: CacheHint): Route => ({
  method: 'GET',
  path: '/posts/:id',
  handler: () => text('ok'),
  meta: { name: 'posts.show', auth: 'public', cache },
});

const register = (cache: CacheHint) => () => createRouter([withCache(cache)]);

const NOT_DELTA_SECONDS = [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2 ** 53];

describe('a cache age that is not delta-seconds is refused where it is written', () => {
  for (const value of NOT_DELTA_SECONDS) {
    test(`maxAgeSeconds: ${String(value)} fails registration, not the first response`, () => {
      expect(register({ mode: 'public', maxAgeSeconds: value })).toThrow(/X_CONFIG_INVALID/);
    });
  }

  test('sMaxAgeSeconds is screened too — it is the one a CDN reads', () => {
    expect(register({ mode: 'public', sMaxAgeSeconds: Number.NaN })).toThrow(/sMaxAgeSeconds/);
  });

  test('staleWhileRevalidateSeconds is screened too', () => {
    expect(
      register({ mode: 'public', staleWhileRevalidateSeconds: Number.POSITIVE_INFINITY }),
    ).toThrow(/staleWhileRevalidateSeconds/);
  });

  test('an immutable hint carries an age like any other, and is screened like one', () => {
    expect(register({ mode: 'immutable', maxAgeSeconds: Number.NaN })).toThrow(/X_CONFIG_INVALID/);
  });

  // The way it actually arrives: `??` guards nullish and `NaN` is not nullish, so an unset
  // variable walks past the default and into the header.
  test('an unset environment value is refused at boot, where the author is standing there', () => {
    const env: Record<string, string | undefined> = {};
    expect(register({ mode: 'public', maxAgeSeconds: Number(env['CACHE_AGE']) })).toThrow(
      /X_CONFIG_INVALID/,
    );
  });

  test('the refusal names the route and the key, because that is the file to edit', () => {
    expect(register({ mode: 'public', maxAgeSeconds: Number.NaN })).toThrow(/posts\.show/);
    expect(register({ mode: 'public', maxAgeSeconds: Number.NaN })).toThrow(/cache\.maxAgeSeconds/);
  });
});

describe('what stays legal, checked against the framework’s own hints', () => {
  test('zero is a declaration — "revalidate every time" — and every default uses it', () => {
    expect(register({ mode: 'public', maxAgeSeconds: 0 })).not.toThrow();
    expect(() => createRouter([withCache(PRIVATE_CACHE)])).not.toThrow();
    expect(() =>
      createRouter([withCache(defaultCache(withCache(PRIVATE_CACHE), anonymousActor()))]),
    ).not.toThrow();
  });

  test('an omitted age is omitted, not zero, and is never screened', () => {
    expect(register({ mode: 'no-store' })).not.toThrow();
    expect(register({ mode: 'immutable' })).not.toThrow();
    expect(register({ mode: 'public', tags: ['feed'], vary: ['accept'] })).not.toThrow();
  });

  test('a whole positive age registers', () => {
    expect(
      register({
        mode: 'public',
        maxAgeSeconds: 60,
        sMaxAgeSeconds: 3600,
        staleWhileRevalidateSeconds: 600,
      }),
    ).not.toThrow();
  });

  test('a route with no cache hint at all is untouched', () => {
    expect(() =>
      createRouter([
        {
          method: 'GET',
          path: '/',
          handler: () => text('ok'),
          meta: { name: 'home', auth: 'public' },
        },
      ]),
    ).not.toThrow();
  });
});
