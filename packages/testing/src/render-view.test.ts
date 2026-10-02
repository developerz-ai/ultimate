// `renderView` / `renderRoute`: the markup and the visible text a test asserts on, and — for a
// route — that `load`, `meta` and the page are one resolution under one actor.

import { describe, expect, test } from 'bun:test';
import { tryUseContext, userActor } from '@ultimat3/core';
import { defineRoute, h, island } from '@ultimat3/render';
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
