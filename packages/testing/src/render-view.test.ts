// `renderView` / `renderRoute`: the markup and the visible text a test asserts on, and — for a
// route — that `load`, `meta` and the page are one resolution under one actor.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tryUseContext, userActor } from '@ultimat3/core';
import { configureLocales, currentLocale, localeConfig } from '@ultimat3/i18n';
import { useRequestCookie } from '@ultimat3/http';
import { defineRoute, h, island, setAssetResolver } from '@ultimat3/render';
import { renderRoute, renderView } from './render-view';

interface GreetingProps {
  readonly name: string;
}

const Greeting = (props: GreetingProps): unknown =>
  h('p', { class: 'greeting' }, 'Hello ', h('strong', null, props.name));

describe('renderView', () => {
  test('answers the markup a document would carry, escaped', async () => {
    const view = await renderView(Greeting, { name: 'Tom & <Jerry>' });
    expect(view.html).toBe(
      '<p class="greeting">Hello <strong>Tom &amp; &lt;Jerry&gt;</strong></p>',
    );
  });

  test('text is what a reader sees: no tags, entities decoded, whitespace collapsed', async () => {
    const view = await renderView(Greeting, { name: 'Tom & <Jerry>' });
    expect(view.text).toBe('Hello Tom & <Jerry>');
  });

  test('text drops script and style bodies, which nobody reads', async () => {
    const Noisy = (): unknown =>
      h(
        'div',
        null,
        h('style', { innerHTML: '.a{color:red}' }),
        h('span', null, 'seen'),
        h('script', { type: 'application/json', innerHTML: '{"hidden":1}' }),
      );
    const view = await renderView(Noisy, {});
    expect(view.html).toContain('{"hidden":1}');
    expect(view.text).toBe('seen');
  });

  test('an escaped ampersand is decoded once — literal `&lt;` text stays text', async () => {
    const view = await renderView(Greeting, { name: '&lt;' });
    expect(view.html).toContain('&amp;lt;');
    expect(view.text).toBe('Hello &lt;');
  });

  test('text decodes what the renderer escapes: an apostrophe and a quote read as typed', async () => {
    const view = await renderView(Greeting, { name: `Tom's "cat"` });
    expect(view.html).toContain('Tom&#39;s &quot;cat&quot;');
    expect(view.text).toBe(`Hello Tom's "cat"`);
  });

  test('text decodes numeric references, decimal and hex, and the common named ones', async () => {
    const Raw = (): unknown =>
      h('p', { innerHTML: 'a&#39;b&#x2019;c&#X41;&nbsp;&copy;&hellip;&mdash;&rsquo;&apos;' });
    const view = await renderView(Raw, {});
    expect(view.text).toBe("a'b\u2019cA\u00a0\u00a9\u2026\u2014\u2019'");
  });

  test('an unknown or malformed reference stays as written; a null or out-of-range one is U+FFFD', async () => {
    const Raw = (): unknown => h('p', { innerHTML: '&bogus; &#xZZ; &#0; &#1114112;' });
    const view = await renderView(Raw, {});
    expect(view.text).toBe('&bogus; &#xZZ; \ufffd \ufffd');
  });

  test('text decodes what a browser shows: `&amp`, `&#39` with no semicolon, `&#128;`', async () => {
    const Raw = (): unknown => h('p', { innerHTML: 'Tom&#39s &amp Jerry &#128;5' });
    const view = await renderView(Raw, {});
    expect(view.text).toBe("Tom's & Jerry \u20ac5");
  });

  test('text keeps a no-break space: a translation may carry one', async () => {
    const Raw = (): unknown => h('p', { innerHTML: '10&nbsp;€' });
    const view = await renderView(Raw, {});
    expect(view.text).toBe('10\u00a0€');
  });

  test('a component that renders an island is refused here: it belongs to a route', async () => {
    const Toggle = island({ src: './toggle.island.tsx', props: [] });
    const WithIsland = (): unknown => h(Toggle, null, 'shell');
    const refused = await renderView(WithIsland, {}).catch((error: unknown) => error);
    expect((refused as { code?: string }).code).toBe('X_ISLAND_NOT_HYDRATED');
    // Drain the declaration so the next `defineRoute` in this file does not inherit it.
    defineRoute({
      render: 'ssr',
      hydrate: 'idle',
      offline: 'runtime',
      budget: { js: '10kb' },
      meta: () => ({ title: 'drain' }),
    });
  });
});

describe('renderRoute', () => {
  interface Loaded {
    readonly rows: readonly string[];
    readonly actorId: string;
  }
  let loads = 0;
  const config = defineRoute<Loaded>({
    render: 'ssr',
    offline: 'runtime',
    load: async (ctx) => {
      loads += 1;
      return {
        rows: [ctx.params['slug'] ?? 'none'],
        actorId: tryUseContext()?.actor.id ?? 'no context',
      };
    },
    meta: ({ data }) => ({ title: `rows: ${data.rows.join(',')}` }),
  });
  const Page = (props: {
    readonly data: Loaded;
    readonly query: Record<string, string>;
    readonly url: string;
  }): unknown =>
    h(
      'main',
      null,
      h('h1', null, props.data.rows[0]),
      h('p', { 'data-role': 'actor' }, props.data.actorId),
      h('p', { 'data-role': 'q' }, props.query['q'] ?? 'no query'),
    );

  test('load runs once, and meta and the page are handed that one object', async () => {
    loads = 0;
    const view = await renderRoute(
      { config, Page },
      { url: 'https://example.test/posts/first?q=term', params: { slug: 'first' } },
    );
    expect(loads).toBe(1);
    expect(view.data.rows).toEqual(['first']);
    expect(view.meta.title).toBe('rows: first');
    expect(view.html).toContain('<h1>first</h1>');
    // The search string reaches the page as `query`, as a request's does.
    expect(view.html).toContain('<p data-role="q">term</p>');
    expect(view.islands).toEqual([]);
  });

  test('load and the page run as the actor the request names', async () => {
    const actor = userActor({ id: 'member-7', orgId: 'org-1' });
    const view = await renderRoute({ config, Page }, { actor });
    expect(view.text).toContain('member-7');
    // No url, no params: the defaults are a bare request for `/`.
    expect(view.text).toContain('none');
    expect(view.text).toContain('no query');
  });

  test('with no actor it runs outside any request context', async () => {
    const view = await renderRoute({ config, Page });
    expect(view.data.actorId).toBe('no context');
  });

  test('an island is collected under the route’s own hydrate, shell rendered', async () => {
    const Toggle = island({ src: './toggle.island.tsx', props: ['label'] });
    const withIsland = defineRoute({
      render: 'ssr',
      hydrate: 'visible',
      offline: 'runtime',
      budget: { js: '10kb' },
      meta: () => ({ title: 'with an island' }),
    });
    const IslandPage = (): unknown => h('main', null, h(Toggle, { label: 'theme' }, 'shell'));
    // The props are the island's own: a key it never declared is a compile error at the call.
    // @ts-expect-error — `labell` is not a prop of Toggle
    h(Toggle, { labell: 'theme' });
    const view = await renderRoute({ config: withIsland, IslandPage });
    expect(view.islands).toHaveLength(1);
    expect(view.islands[0]?.strategy).toBe('visible');
    expect(view.text).toBe('shell');
  });

  test('a module with no page component is refused by name', async () => {
    const refused = await renderRoute({ config }).catch((error: unknown) => error);
    expect((refused as { code?: string }).code).toBe('X_INVARIANT');
    expect((refused as { cause?: string }).cause).toContain('exports no page component');
  });
});

describe('renderRoute · the locale prefix', () => {
  // The locale config is process-global: put back what this file found.
  const before = localeConfig();
  beforeEach(() => configureLocales({ supported: ['en', 'es'], fallback: 'en' }));
  afterEach(() => configureLocales(before));

  const config = defineRoute({
    render: 'ssr',
    offline: 'runtime',
    meta: ({ locale }) => ({ title: `meta in ${locale}` }),
  });
  const Page = (): unknown => h('p', null, `page in ${currentLocale()}`);

  test('a routed `/<locale>/` prefix renders load, the page and its meta in that locale', async () => {
    const loading = defineRoute({
      render: 'ssr',
      offline: 'runtime',
      load: () => ({ locale: currentLocale() }),
      meta: ({ locale }) => ({ title: `meta in ${locale}` }),
    });
    const view = await renderRoute({ config: loading, Page }, { url: 'https://example.test/es/' });
    expect(view.data).toEqual({ locale: 'es' });
    expect(view.text).toBe('page in es');
    expect(view.meta.title).toBe('meta in es');
  });

  test('the prefix and the actor share one request context', async () => {
    const actor = userActor({ id: 'member-7', orgId: 'org-1' });
    const Who = (): unknown => h('p', null, `${tryUseContext()?.actor.id} ${currentLocale()}`);
    const view = await renderRoute({ config, Who }, { url: 'https://example.test/es/a', actor });
    expect(view.text).toBe('member-7 es');
  });

  test('an unprefixed URL, or a segment that is no routed locale, is the default, context-free', async () => {
    const Where = (): unknown =>
      h('p', null, `page in ${currentLocale()} ${tryUseContext() === undefined ? 'bare' : 'ctx'}`);
    const plain = await renderRoute({ config, Where }, { url: 'https://example.test/precios' });
    expect(plain.text).toBe('page in en bare');
    const unrouted = await renderRoute({ config, Where }, { url: 'https://example.test/fr/' });
    expect(unrouted.text).toBe('page in en bare');
  });
});

describe('renderRoute · the app-wide favicon', () => {
  // The site asset table is process-global, like every other registry this run touches: a
  // resolver left installed would answer the NEXT file's `asset()` with this one's table.
  afterEach(() => setAssetResolver(undefined));

  const config = defineRoute({
    render: 'ssr',
    offline: 'runtime',
    meta: () => ({ title: 'favicon' }),
  });
  const Page = (): unknown => h('main', null, h('h1', null, 'favicon'));

  test('with no site asset table installed the route still renders, and carries no favicon', async () => {
    const view = await renderRoute({ config, Page }, { favicon: 'assets/brand/icon.svg' });
    // The route rendered: the refusal a resolver-free render would raise is not here.
    expect(view.html).toContain('<h1>favicon</h1>');
    expect(view.favicon).toBeUndefined();
  });

  test('with a table installed the favicon resolves to the URL the asset surface serves', async () => {
    setAssetResolver((path) => {
      if (path === 'assets/brand/icon.svg') return '/assets/brand/icon.0123abcd.svg';
      return `/${path}`;
    });
    const view = await renderRoute({ config, Page }, { favicon: 'assets/brand/icon.svg' });
    expect(view.favicon).toBe('/assets/brand/icon.0123abcd.svg');
    // The route rendered beside it: the favicon is the app's, never the page's.
    expect(view.html).toContain('<h1>favicon</h1>');
  });

  test('an app that declares no favicon resolves nothing and asks for nothing', async () => {
    const view = await renderRoute({ config, Page });
    expect(view.favicon).toBeUndefined();
    expect(view.html).toContain('<h1>favicon</h1>');
  });
});

describe('renderRoute · the cookies a request carries', () => {
  const config = defineRoute<{ readonly session: string; readonly actorId: string }>({
    render: 'ssr',
    offline: 'runtime',
    // What a page that reads a cookie does: `useRequestCookie`, the one reader app code has.
    load: async () => ({
      session: useRequestCookie('sid') ?? 'no cookie',
      actorId: tryUseContext()?.actor.id ?? 'no context',
    }),
    meta: () => ({ title: 'cookie' }),
  });
  const Page = (props: { readonly data: { readonly session: string } }): unknown =>
    h('p', null, props.data.session);

  test('load reads the cookie, decoded, under the url asked for', async () => {
    const view = await renderRoute(
      { config, Page },
      { url: 'https://example.test/account', cookies: { sid: 'a b;c' } },
    );
    expect(view.data.session).toBe('a b;c');
    expect(view.text).toContain('a b;c');
  });

  test('cookies and an actor together: the actor still acts', async () => {
    const actor = userActor({ id: 'member-9', orgId: 'org-1' });
    const view = await renderRoute({ config, Page }, { actor, cookies: { sid: 's-1' } });
    expect([view.data.session, view.data.actorId]).toEqual(['s-1', 'member-9']);
  });
});
