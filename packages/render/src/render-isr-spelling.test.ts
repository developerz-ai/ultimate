// The ISR key and the controller against the ways one address is spelled. The key is derived from
// `@ultimat3/http`'s `canonicalPath` — the router's own segments and decoding — so a spelling the
// router answers with a page is that page's ONE entry; and a key no route owns, which carries
// neither a ttl nor a tag, is never stored for a bust to miss.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { isolateGraph, resetGraph, tag } from '@ultimat3/cache';
import { clearRoutes, describePages } from './registry';
import { isrController } from './render-isr';
import { isrKeyIn, isrRouteWith } from './render-isr-fixture';
import { memoryIsrStore } from './render-isr-store';

const postTag = tag('post');
const ARTICLE = 'apps/web/site/blog/[slug]/page.tsx';
const KEY = '/blog/abc?__x_locale=en';

const SPELLINGS: string[] = [
  '/blog/abc',
  '/blog/%61bc',
  '/blog/%61%62%63',
  '/blog/abc/',
  '/blog//abc',
  '//blog/abc',
  '//blog//abc//',
  '/blog/./abc',
  '/blog/x/../abc',
  '/blog/%2E/abc',
  '/%62log/abc',
];

const restoreGraph = isolateGraph();

beforeEach(() => {
  clearRoutes();
  resetGraph();
});

afterAll(() => {
  clearRoutes();
  restoreGraph();
});

describe('unit · isrKey spells an address one way', () => {
  test.each(SPELLINGS)('%s is the /blog/abc key', (spelling) => {
    expect(isrKeyIn(spelling)).toBe(KEY);
  });

  test('hex case, a non-ASCII letter and the query order do not split a page', () => {
    expect(isrKeyIn('/blog/caf%c3%a9')).toBe(isrKeyIn('/blog/caf%C3%A9'));
    expect(isrKeyIn('/blog/café')).toBe('/blog/caf%C3%A9?__x_locale=en');
    expect(isrKeyIn('/blog//abc/?b=2&a=1')).toBe('/blog/abc?__x_locale=en&a=1&b=2');
  });

  test('an encoded slash is its own page, never the two-segment path', () => {
    expect(isrKeyIn('/blog/a%2fb')).toBe('/blog/a%2Fb?__x_locale=en');
    expect(isrKeyIn('/blog/a%2Fb')).not.toBe(isrKeyIn('/blog/a/b'));
    expect(isrKeyIn('/blog/a%252Fb')).not.toBe(isrKeyIn('/blog/a%2Fb'));
  });

  test('a locale prefix is kept, in the one spelling of what follows it', () => {
    expect(isrKeyIn('/en//blog/%61bc/', 'en')).toBe('/en/blog/abc?__x_locale=en');
  });
});

describe.each(['purge', 'stale'] as const)(
  'unit · a %s bust reaches the page however it was asked for',
  (onInvalidate) => {
    test.each(SPELLINGS)('%s', async (spelling) => {
      isrRouteWith(ARTICLE, { tags: [postTag], ttl: '10m', onInvalidate });
      const controller = isrController({ routes: describePages });
      const served = await controller.serve(isrKeyIn(spelling), () => '<p>the article</p>');
      expect(served.entry.ttlMs).toBe(600_000);
      expect(served.result.headers['surrogate-key']).toBe('post e:post');
      expect(controller.store().paths()).toEqual([KEY]);

      expect(controller.revalidateByTags([postTag])).toEqual([KEY]);
      const held = controller.store().get(KEY);
      if (onInvalidate === 'purge') expect(held).toBeUndefined();
      else expect(held?.stale).toBe(true);
    });
  },
);

describe('unit · a key no route owns is never stored', () => {
  const UNOWNED = '/nothing/here?__x_locale=en';

  test('it is rendered for each request that asks, private, with no ttl and no purge key', async () => {
    isrRouteWith(ARTICLE, { tags: [postTag], ttl: '10m', onInvalidate: 'purge' });
    const controller = isrController({ routes: describePages });
    let renders = 0;
    const render = (): string => {
      renders += 1;
      return '<p>whose page is this</p>';
    };
    for (const _ of [1, 2, 3]) {
      const served = await controller.serve(UNOWNED, render);
      expect(served.state).toBe('miss');
      expect(served.result.status).toBe(200);
      expect(served.result.headers['cache-control']).toBe('private, no-store');
      expect(served.result.headers['surrogate-key']).toBeUndefined();
    }
    expect(renders).toBe(3);
    expect(controller.store().paths()).toEqual([]);
    expect(controller.inflight()).toBe(0);
  });

  test('regenerate() does not store it either', async () => {
    const controller = isrController({ routes: describePages });
    await controller.regenerate(UNOWNED, () => '<p>x</p>');
    expect(controller.store().paths()).toEqual([]);
  });

  test('a copy an earlier release left under such a key is dropped, not served', async () => {
    isrRouteWith(ARTICLE, { tags: [postTag], ttl: '10m', onInvalidate: 'purge' });
    const store = memoryIsrStore();
    // The raw spelling 27.8.0 stored: the route table cannot read `/blog//abc` back.
    const left = '/blog//abc?__x_locale=en';
    store.set({
      path: left,
      html: '<p>WITHDRAWN</p>',
      hash: 'h',
      generatedAt: Date.now(),
      ttlMs: null,
      stale: false,
    });
    const controller = isrController({ store, routes: describePages });
    const served = await controller.serve(left, () => '<p>rendered now</p>');
    expect(served.state).toBe('miss');
    expect(served.result.body).toBe('<p>rendered now</p>');
    expect(store.paths()).toEqual([]);
  });
});
