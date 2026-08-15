/**
 * The specification: one interactive component on an otherwise static page, shipping only its
 * own JavaScript. Failure cases first — an island that can never boot, and props that would
 * carry the server into the browser, both fail before the "it works" case is even asked.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { BudgetExceededError } from './errors';
import { hydrateRuntime, hydrateRuntimeBytes } from './hydrate';
import { ISLAND_EXTENSION, island } from './island';
import { createIslandCollector, islandModuleIds } from './island-collector';
import { ISLAND_PROPS_MAX_BYTES } from './island-props';
import type { Island } from './islands';
import { assertBudget, checkBudget, routeJsBytes } from './islands';
import { h } from './jsx';
import { clearRoutes, registerRoute } from './registry';
import { renderToHtml } from './render-html';
import type { RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'Pricing', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;

const PAGE = 'apps/web/site/pricing/page.tsx';

const pricingRoute = () =>
  registerRoute({
    file: PAGE,
    config: defineRoute({
      render: 'static',
      offline: 'precache',
      hydrate: 'interaction',
      budget: { js: '10kb' },
      meta,
    }),
  });

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof UltimateError ? error.code : `not-an-UltimateError: ${String(error)}`;
  }
  return 'did-not-throw';
};

const asyncCodeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof UltimateError ? error.code : `not-an-UltimateError: ${String(error)}`;
  }
  return 'did-not-throw';
};

beforeEach(() => {
  clearRoutes();
});

describe('island · a declaration that cannot ship', () => {
  test('a specifier that is not an island file is refused where it is written', () => {
    expect(codeOf(() => island({ src: './contact-modal.tsx' }))).toBe('X_ISLAND_INVALID');
    expect(codeOf(() => island({ src: '' }))).toBe('X_ISLAND_INVALID');
    expect(codeOf(() => island({ src: `https://cdn.example.com/x${ISLAND_EXTENSION}` }))).toBe(
      'X_ISLAND_INVALID',
    );
  });

  test('the fix names the rename, because the filename is what makes a file a client entry', () => {
    try {
      island({ src: './contact-modal.tsx' });
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(UltimateError);
      expect((error as UltimateError).fix).toContain(`contact-modal${ISLAND_EXTENSION}`);
    }
  });
});

describe('island · an island that can never boot', () => {
  test("hydrate: 'never' plus an island is a contradiction the route has to resolve", async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}` });
    const collector = createIslandCollector({ file: PAGE, hydrate: 'never' });
    const code = await asyncCodeOf(() =>
      renderToHtml(h(Modal, null, 'Contact us'), { islands: collector }),
    );
    expect(code).toBe('X_ISLAND_NOT_HYDRATED');
  });

  test('rendering an island with no collector is the same failure: nothing would boot it', async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}` });
    expect(await asyncCodeOf(() => renderToHtml(h(Modal, null, 'Contact us')))).toBe(
      'X_ISLAND_NOT_HYDRATED',
    );
  });

  test('the fix is the exact edit: the route file, the strategy and the budget', async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}` });
    const collector = createIslandCollector({ file: PAGE, hydrate: 'never' });
    try {
      await renderToHtml(h(Modal, null, 'x'), { islands: collector });
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(UltimateError);
      expect((error as UltimateError).fix).toContain(PAGE);
      expect((error as UltimateError).fix).toContain('budget');
    }
  });
});

describe('island · what an island may close over', () => {
  const render = (node: unknown): Promise<string> =>
    renderToHtml(node, {
      islands: createIslandCollector({ file: PAGE, hydrate: 'interaction' }),
    });

  test('an undeclared prop is refused by name — a spread entity row names every column', async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}`, props: ['subject'] });
    const row = { subject: 'pricing', email: 'a@b.c', passwordHash: 'deadbeef' };
    const code = await asyncCodeOf(() => render(h(Modal, row)));
    expect(code).toBe('X_ISLAND_PROPS_INVALID');
  });

  test('a value the browser could never receive is refused, naming the path and the type', async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}`, props: ['db', 'at'] });
    const db = { query: () => Promise.resolve([]) };
    expect(await asyncCodeOf(() => render(h(Modal, { db })))).toBe('X_ISLAND_PROPS_INVALID');
    expect(await asyncCodeOf(() => render(h(Modal, { at: new Date(0) })))).toBe(
      'X_ISLAND_PROPS_INVALID',
    );
  });

  test('props over the cap are refused: every byte here ships in the HTML on every request', async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}`, props: ['blob'] });
    const blob = 'x'.repeat(ISLAND_PROPS_MAX_BYTES + 1);
    expect(await asyncCodeOf(() => render(h(Modal, { blob })))).toBe('X_ISLAND_PROPS_INVALID');
  });

  test('children are the server shell, never serialized props', async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}`, props: ['subject'] });
    const html = await render(h(Modal, { subject: 'pricing' }, h('button', null, 'Contact us')));
    expect(html).toContain('<button>Contact us</button>');
    expect(html).toContain('{"subject":"pricing"}');
    expect(html).not.toContain('"children"');
  });
});

describe('island · a static page ships JS for only its island', () => {
  test('the whole contract, on one page', async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}`, props: ['subject'] });
    const Hero = () => h('h1', null, 'Pricing');

    const collector = createIslandCollector({ file: PAGE, hydrate: 'interaction' });
    const html = await renderToHtml(
      h(
        'main',
        null,
        h(Hero, null),
        h(Modal, { subject: 'pricing' }, h('button', null, 'Contact us')),
      ),
      { islands: collector },
    );

    // The static half renders with no hydration attributes at all.
    const beforeIsland = html.slice(0, html.indexOf('data-x-island'));
    expect(beforeIsland).toContain('<h1>Pricing</h1>');
    expect(beforeIsland).not.toContain('data-x');

    // Exactly one client entry on the page, and it is the island's own module.
    const entries = [...html.matchAll(/data-x-entry="([^"]+)"/g)].map((m) => m[1]);
    expect(entries).toEqual([`./contact-modal${ISLAND_EXTENSION}`]);
    expect(html).toContain('data-x-hydrate="interaction"');

    // Only the runtime this page's one strategy needs — idle and visible cost nothing.
    const runtime = hydrateRuntime(collector.directives);
    expect(runtime).toContain('data-x-hydrate="interaction"');
    expect(runtime).not.toContain('requestIdleCallback');
    expect(runtime).not.toContain('IntersectionObserver');

    // And the budget counts that island and that runtime — nothing for <Hero>.
    const entry = pricingRoute();
    const measured: readonly Island[] = [
      {
        id: islandModuleIds(collector.directives)[0] ?? '',
        file: `apps/web/site/pricing/contact-modal${ISLAND_EXTENSION}`,
        graph: 'site',
        strategy: 'interaction',
        bytes: 3 * 1024,
      },
    ];
    const bytes = routeJsBytes(entry, measured, collector.directives);
    expect(bytes.islandBytes).toBe(3 * 1024);
    expect(bytes.runtimeBytes).toBe(hydrateRuntimeBytes(collector.directives));
    expect(bytes.total).toBe(3 * 1024 + bytes.runtimeBytes);
  });

  test('the same island twice gets one module and two prop bags', async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}`, props: ['subject'] });
    const collector = createIslandCollector({ file: PAGE, hydrate: 'interaction' });
    const html = await renderToHtml(
      h('main', null, h(Modal, { subject: 'top' }), h(Modal, { subject: 'bottom' })),
      { islands: collector },
    );

    expect(islandModuleIds(collector.directives)).toEqual(['contact-modal']);
    const ids = [...html.matchAll(/data-x-island="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
    expect(html).toContain('{"subject":"top"}');
    expect(html).toContain('{"subject":"bottom"}');
  });

  test('an island that outgrows the route budget fails the build, naming the island', async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}` });
    const collector = createIslandCollector({ file: PAGE, hydrate: 'interaction' });
    await renderToHtml(h(Modal, null, 'Contact us'), { islands: collector });

    const entry = pricingRoute();
    const measured: readonly Island[] = [
      {
        id: 'contact-modal',
        file: `apps/web/site/pricing/contact-modal${ISLAND_EXTENSION}`,
        graph: 'site',
        strategy: 'interaction',
        bytes: 40 * 1024,
      },
    ];
    // The route declared 10kb. Without the island counted this passes at 0 measured bytes, which
    // is the budget quietly meaning nothing — the whole reason the directives are a second source.
    expect(() => assertBudget(entry, measured, collector.directives)).toThrow(BudgetExceededError);
    expect(checkBudget(entry, measured, collector.directives).cause).toContain('contact-modal');
  });

  test('the built chunk URL replaces the specifier through one hook, nothing else', async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}` });
    const collector = createIslandCollector({
      file: PAGE,
      hydrate: 'idle',
      resolve: () => '/_x/islands/contact-modal.9f2a1c.js',
    });
    const html = await renderToHtml(h(Modal, null, 'shell'), { islands: collector });
    expect(html).toContain('data-x-entry="/_x/islands/contact-modal.9f2a1c.js"');
  });
});
