// The default is the answer for every route that declared no hint, so a wrong one is wrong
// everywhere at once — and its worst form is silent: a correct-looking page, served to the wrong
// person by a cache neither of them can see.
import { describe, expect, test } from 'bun:test';
import { anonymousActor, userActor } from '@ultimat3/core';
import { defaultCache } from './cache-policy';
import { cacheControl } from './response';
import type { Route } from './router';

const route = (auth: 'public' | 'required'): Route => ({
  method: 'GET',
  path: '/x',
  meta: { name: 'x', auth },
  handler: () => new Response(null),
});

describe('defaultCache', () => {
  test('no route at all is no-store — a 404 or a 500 is nobody else’s answer', () => {
    expect(defaultCache(undefined, anonymousActor())).toEqual({ mode: 'no-store' });
  });

  test("auth: 'required' is no-store whoever asks", () => {
    expect(defaultCache(route('required'), anonymousActor())).toEqual({ mode: 'no-store' });
    expect(defaultCache(route('required'), userActor({ id: 'u1' }))).toEqual({ mode: 'no-store' });
  });

  test('a public route is shared-cacheable for an anonymous visitor', () => {
    expect(cacheControl(defaultCache(route('public'), anonymousActor()))).toBe(
      'public, max-age=0, s-maxage=60, stale-while-revalidate=600',
    );
  });

  // `meta.auth` cannot express "public, but personalised when you are signed in", which is the
  // commonest page there is. The actor is what tells the two apart.
  test('the same public route is private once the request carries an identity', () => {
    const hint = defaultCache(route('public'), userActor({ id: 'u1' }));
    expect(hint.mode).toBe('private');
    expect(cacheControl(hint)).not.toContain('s-maxage');
  });
});
