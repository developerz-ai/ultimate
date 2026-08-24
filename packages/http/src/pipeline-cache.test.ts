// One question: who has the LAST word on `cache-control` when the handler already wrote one.
// Split from `pipeline.test.ts` (at the file-size ceiling), which asks the same question for the
// handler that wrote none.
//
// The bug it pins: `@ultimat3/render`'s `ssrHeaders` writes
// `public, max-age=0, s-maxage=30, stale-while-revalidate=300` for any route that declares no
// `policy` — and `x g route --surface app` scaffolds exactly that route. The body of an `ssr` page
// can greet the actor by name, because `meta.auth` is `'public' | 'required'` and "public, but
// personalised when you are signed in" is the commonest page there is. The `cache-headers` stage
// applied the actor-aware default only when nothing had set a header, so for every page route in
// every app the rule beside it was unreachable.

import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { createRateLimiter } from './rate-limit';
import { html } from './response';
import { createRouter, type Route } from './router';

/** What `renderSsr` puts on an ungated page, verbatim. */
const SSR_CACHE = 'public, max-age=0, s-maxage=30, stale-while-revalidate=300';

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/page',
    meta: { name: 'page', auth: 'public' },
    handler: (_request, ctx) =>
      html(`hello ${ctx.actor.id}`, {
        headers: { 'cache-control': SSR_CACHE, vary: 'accept-language' },
      }),
  },
  {
    method: 'GET',
    path: '/chunk.js',
    // A content-addressed island chunk: the bytes are a function of the URL, so sharing one
    // between two actors is exactly what the URL promises.
    meta: { name: 'chunk', auth: 'public' },
    handler: () =>
      html('export const mount = () => {};', {
        headers: { 'cache-control': 'public, max-age=31536000, immutable' },
      }),
  },
];

const pipelineWith = (actorId?: string) =>
  createPipeline({
    table: createRouter(routes),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
    limiter: createRateLimiter({
      config: {
        enabled: true,
        defaultBucket: 'default',
        tenantBucket: null,
        scope: 'process',
        buckets: { default: { capacity: 100, refillPerSecond: 1 } },
      },
    }),
    hooks: { authenticate: () => (actorId === undefined ? null : ({ id: actorId } as never)) },
  });

const get = (path: string) => new Request(`http://localhost${path}`);

describe('a handler-declared cache-control is reviewed, never obeyed', () => {
  test('an identified request is never offered to a shared cache, whatever the page said', async () => {
    const response = await pipelineWith('actor-1').handle(get('/page'), { role: 'web' });
    expect(await response.text()).toContain('actor-1');
    const control = response.headers.get('cache-control') ?? '';
    expect(control).toContain('private');
    expect(control).not.toContain('s-maxage');
    expect(control).not.toContain('public');
  });

  test('an anonymous request keeps the mode’s intent and gains the missing key dimensions', async () => {
    const response = await pipelineWith().handle(get('/page'), { role: 'web' });
    expect(response.headers.get('cache-control')).toBe(SSR_CACHE);
    const vary = (response.headers.get('vary') ?? '').split(', ');
    // The route wrote `accept-language` alone. A session travels in a cookie and `ctx.tz` comes
    // off a header, so a CDN keying on neither serves one visitor's document to the next.
    expect(vary).toContain('accept-language');
    expect(vary).toContain('cookie');
    expect(vary).toContain('x-timezone');
  });

  test('an immutable answer stays shared for a signed-in actor', async () => {
    const response = await pipelineWith('actor-1').handle(get('/chunk.js'), { role: 'web' });
    // Demoting this one would re-download every island chunk on every navigation, for every
    // signed-in user, to protect a body that is a function of its own URL.
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });
});
