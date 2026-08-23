/**
 * The specification: one interactive component on an otherwise static page, shipping only its
 * own JavaScript. Failure cases first — an island that can never boot, and props that would
 * carry the server into the browser, both fail before the "it works" case is even asked.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { hydrateRuntime } from './hydrate';
import {
  clearDeclaredIslands,
  drainDeclaredIslands,
  ISLAND_EXTENSION,
  isIslandNode,
  island,
} from './island';
import { createIslandCollector, islandModuleIds } from './island-collector';
import { ISLAND_PROPS_MAX_BYTES } from './island-props';
import { parseByteBudget } from './islands';
import { h } from './jsx';
import { DEFAULT_ISLAND_JS_BYTES, defaultIslandBudget } from './modes';
import { clearRoutes, registerRoute } from './registry';
import { renderToHtml } from './render-html';
import type { RouteMetaFn } from './route';
import { defineRoute } from './route';
import { SURFACE_SPECS } from './surfaces';

const meta = (() => ({ title: 'Pricing', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;

const PAGE = 'apps/web/site/pricing/page.tsx';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof UltimateError ? error.code : `not-an-UltimateError: ${String(error)}`;
  }
  return 'did-not-throw';
};

/** The `fix:` line, so a test can pin WHICH remediation a caller is handed, not just the code. */
const fixOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof UltimateError ? error.fix : `not-an-UltimateError: ${String(error)}`;
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
  // The declaration list is drained by `defineRoute`, so a test that declares an island and never
  // defines a route would hand it to the next test's route. One line here, not a rule to remember.
  clearDeclaredIslands();
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

describe('island · a specifier that cannot be emitted', () => {
  // `src` lands verbatim inside `data-x-entry="…"`. A quote closes the attribute, a backtick or an
  // angle bracket opens something else — so the character set is checked at the declaration, not
  // escaped at the emit, and `isEmittableSpecifier` is the same test the resolver's output faces.
  test.each([
    ['a double quote', './ca"rt.island.tsx'],
    ['a single quote', "./ca'rt.island.tsx"],
    ['a backtick', './ca`rt.island.tsx'],
    ['an angle bracket', './<cart>.island.tsx'],
    ['a space', './my cart.island.tsx'],
    ['a backslash', '.\\cart.island.tsx'],
  ])('%s in src is refused where it is written', (_name, src) => {
    expect(codeOf(() => island({ src }))).toBe('X_ISLAND_INVALID');
  });

  test('the cause quotes the specifier and the fix names the rename', () => {
    let caught: UltimateError | undefined;
    try {
      island({ src: './my cart.island.tsx' });
    } catch (error) {
      caught = error instanceof UltimateError ? error : undefined;
    }
    expect(caught?.cause).toContain(JSON.stringify('./my cart.island.tsx'));
    expect(caught?.fix).toContain(`src: './<name>${ISLAND_EXTENSION}'`);
  });

  test('a src that is nothing but the extension has no name left to be an id', () => {
    // It passes every earlier check — it IS an island file — and fails on the id, which is what
    // the budget report and the manifest key on.
    expect(codeOf(() => island({ src: ISLAND_EXTENSION }))).toBe('X_ISLAND_INVALID');
    expect(codeOf(() => island({ src: `./${ISLAND_EXTENSION}` }))).toBe('X_ISLAND_INVALID');
    expect(codeOf(() => island({ src: `./---${ISLAND_EXTENSION}` }))).toBe('X_ISLAND_INVALID');
  });

  test('a remote specifier is outside the bundle graph the budget has to count', () => {
    expect(codeOf(() => island({ src: 'https://cdn.example.com/cart.island.tsx' }))).toBe(
      'X_ISLAND_INVALID',
    );
  });

  test('no src at all is refused before anything is derived from it', () => {
    expect(codeOf(() => island({ src: '' }))).toBe('X_ISLAND_INVALID');
    expect(codeOf(() => island({ src: 7 as unknown as string }))).toBe('X_ISLAND_INVALID');
  });

  test('a refused declaration never reaches the pending list the route drains', () => {
    // The throw is in the normalizer, before the push — so the next `defineRoute` cannot inherit
    // a half-built spec and derive `hydrate` from an island that does not exist.
    expect(codeOf(() => island({ src: './my cart.island.tsx' }))).toBe('X_ISLAND_INVALID');
    expect(codeOf(() => island({ src: ISLAND_EXTENSION }))).toBe('X_ISLAND_INVALID');
    island({ src: './cart.island.tsx' });
    expect(drainDeclaredIslands().map((spec) => spec.moduleId)).toEqual(['cart']);
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

  test('the fix names the route file, and one edit — not a menu to choose from', async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}` });
    const collector = createIslandCollector({ file: PAGE, hydrate: 'never' });
    try {
      await renderToHtml(h(Modal, null, 'x'), { islands: collector });
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(UltimateError);
      expect((error as UltimateError).fix).toContain(PAGE);
      // Which edit depends on the cause, and the throw site knows it — see the two-cause test
      // below. What must never happen is both, leaving the reader to work out which half is theirs.
      expect((error as UltimateError).fix).toContain('island');
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
    const code = await asyncCodeOf(() => render(Modal(row)));
    expect(code).toBe('X_ISLAND_PROPS_INVALID');
  });

  test('a value the browser could never receive is refused, naming the path and the type', async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}`, props: ['db', 'at'] });
    const db = { query: () => Promise.resolve([]) };
    // Both halves are the contract, and each `@ts-expect-error` carries one of them: a handle and
    // a `Date` are not `JsonValue`, so the type refuses the prop (`type-pins.tsx` pins that), and
    // the render refuses it again for the caller that arrived through `renderToHtml(node: unknown)`
    // — an untyped spread, a JS caller, a value laundered through `unknown`. Deleting either check
    // makes exactly one of these two lines fail.
    // @ts-expect-error a database handle is not a JsonValue, and `at` is not supplied
    expect(await asyncCodeOf(() => render(Modal({ db })))).toBe('X_ISLAND_PROPS_INVALID');
    // @ts-expect-error a Date is not a JsonValue, and `db` is not supplied
    expect(await asyncCodeOf(() => render(Modal({ at: new Date(0) })))).toBe(
      'X_ISLAND_PROPS_INVALID',
    );
  });

  test('props over the cap are refused: every byte here ships in the HTML on every request', async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}`, props: ['blob'] });
    const blob = 'x'.repeat(ISLAND_PROPS_MAX_BYTES + 1);
    expect(await asyncCodeOf(() => render(Modal({ blob })))).toBe('X_ISLAND_PROPS_INVALID');
  });

  test('children are the server shell, never serialized props', async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}`, props: ['subject'] });
    const html = await render(
      Modal({ subject: 'pricing', children: h('button', null, 'Contact us') }),
    );
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
        Modal({ subject: 'pricing', children: h('button', null, 'Contact us') }),
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

    // And exactly one module id is on the page for the budget to weigh — nothing for <Hero>.
    // Weighing it is `@ultimat3/cli`'s `checkBudgets`, over the emitted document; render's own
    // graph-based half was deleted 2026-08-23 with no caller outside this file.
    expect(islandModuleIds(collector.directives)).toEqual(['contact-modal']);
  });

  test('the same island twice gets one module and two prop bags', async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}`, props: ['subject'] });
    const collector = createIslandCollector({ file: PAGE, hydrate: 'interaction' });
    const html = await renderToHtml(
      h('main', null, Modal({ subject: 'top' }), Modal({ subject: 'bottom' })),
      { islands: collector },
    );

    expect(islandModuleIds(collector.directives)).toEqual(['contact-modal']);
    const ids = [...html.matchAll(/data-x-island="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
    expect(html).toContain('{"subject":"top"}');
    expect(html).toContain('{"subject":"bottom"}');
  });

  test('an island node is a JSX child, which is what makes `<Modal />` compile', async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}` });
    const node = Modal({});
    // The shape `solid-js`'s `JSX.Element` admits — see `type-pins.tsx` for the compile-time half.
    expect(Array.isArray(node)).toBe(true);
    expect(isIslandNode(node)).toBe(true);
    // …and the walker must still see the island, not an empty array: order, not luck.
    const html = await renderToHtml(node, {
      islands: createIslandCollector({ file: PAGE, hydrate: 'idle' }),
    });
    expect(html).toContain('data-x-island="contact-modal-1"');
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

describe('island · declaring one is the whole declaration', () => {
  /** Everything the pricing page used to spell out three times, spelled once. */
  const pageWithIsland = () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}`, props: ['subject'] });
    const config = defineRoute({ render: 'static', offline: 'precache', meta });
    return { Modal, config };
  };

  test('a page that declares an island hydrates, and is charged, without saying either', async () => {
    const { Modal, config } = pageWithIsland();
    // 1. the timing the route never stated
    expect(config.hydrate).toBe('interaction');
    expect(config.islands.map((spec) => spec.moduleId)).toEqual(['contact-modal']);

    // 2. the ceiling the route never stated — site/'s 0kb baseline plus the island allowance,
    // whose SIZE is `modes.ts`'s business and whose application here is this test's
    const entry = registerRoute({ file: PAGE, config });
    expect(entry.config.budget.js).toBe(defaultIslandBudget('site'));
    expect(parseByteBudget(entry.config.budget.js)).toBe(DEFAULT_ISLAND_JS_BYTES);
    expect(entry.islands).toEqual(['contact-modal']);

    // 3. it renders, and the browser is told to boot it
    const collector = createIslandCollector({ file: PAGE, hydrate: entry.config.hydrate });
    const html = await renderToHtml(Modal({ subject: 'pricing', children: 'Contact us' }), {
      islands: collector,
    });
    expect(html).toContain('data-x-hydrate="interaction"');
    expect(html).toContain(`data-x-entry="./contact-modal${ISLAND_EXTENSION}"`);
    expect(hydrateRuntime(collector.directives)).toContain('addEventListener');

    // 4. and the module id the built chunk is weighed under is on the page. What weighs it is
    // `@ultimat3/cli`'s `checkBudgets`, against the manifest's `budget.js` written in step 2.
    expect(islandModuleIds(collector.directives)).toEqual(['contact-modal']);
  });

  test('the declaration reaches the route entry even when no render produced a directive', () => {
    const { config } = pageWithIsland();
    const entry = registerRoute({ file: PAGE, config });
    // `entry.islands` was `[]` on every route ever registered, and it is the only record a build
    // has of an island a page declared but did not render on this pass.
    expect(entry.islands).toEqual(['contact-modal']);
  });

  test('a declaration still wins, both of them', () => {
    island({ src: `./contact-modal${ISLAND_EXTENSION}` });
    const config = defineRoute({
      render: 'static',
      offline: 'precache',
      hydrate: 'visible',
      budget: { js: '12kb' },
      meta,
    });
    const entry = registerRoute({ file: PAGE, config });
    expect(entry.config.hydrate).toBe('visible');
    expect(entry.config.budget.js).toBe('12kb');
  });

  test('a page with no island ships nothing and is given no budget to hide behind', () => {
    const config = defineRoute({ render: 'static', offline: 'precache', meta });
    expect(config.hydrate).toBe('never');
    expect(config.islands).toEqual([]);
    expect(registerRoute({ file: PAGE, config }).config.budget.js).toBeUndefined();
  });

  test('the derived ceiling is above the surface baseline, not a number site/ and app/ share', () => {
    island({ src: `./contact-modal${ISLAND_EXTENSION}` });
    const config = defineRoute({ render: 'stream', offline: 'runtime', meta });
    // app/ ships 14kb of framework runtime before any island opts in, so the allowance ALONE
    // would be a ceiling every app/ route fails on arrival.
    const entry = registerRoute({
      file: 'apps/web/app/dashboard/page.tsx',
      config,
      suspenseBoundaries: 1,
    });
    expect(entry.config.budget.js).toBe(defaultIslandBudget('app'));
    // …and the two surfaces do not share it: the gap IS app/'s baseline. Derived, never restated —
    // `'18kb'` made one correction of `DEFAULT_ISLAND_JS_BYTES` (`modes.test.ts` owns its value)
    // a two-file edit, and this file was never about the number.
    expect(parseByteBudget(entry.config.budget.js)).toBe(
      (parseByteBudget(defaultIslandBudget('site')) ?? 0) + SURFACE_SPECS.app.jsBaselineBytes,
    );
    expect(SURFACE_SPECS.app.jsBaselineBytes).toBeGreaterThan(0);
  });

  test('islands drain per route: the next page is not billed for this one', () => {
    island({ src: `./contact-modal${ISLAND_EXTENSION}` });
    expect(defineRoute({ render: 'static', offline: 'precache', meta }).islands).toHaveLength(1);
    expect(defineRoute({ render: 'static', offline: 'precache', meta }).islands).toHaveLength(0);
  });

  test("hydrate: 'never' beside an island is still refused — the author stated it on purpose", async () => {
    const Modal = island({ src: `./contact-modal${ISLAND_EXTENSION}` });
    const config = defineRoute({
      render: 'static',
      offline: 'precache',
      hydrate: 'never',
      meta,
    });
    expect(config.hydrate).toBe('never');
    // No derived ceiling: a route that ships nothing has nothing to budget, and one here would
    // paper over the contradiction the render is about to name.
    const entry = registerRoute({ file: PAGE, config });
    expect(entry.config.budget.js).toBeUndefined();

    // The registration is not the refusal. This is: the island is reached, and rejected.
    const collector = createIslandCollector({ file: PAGE, hydrate: entry.config.hydrate });
    expect(await asyncCodeOf(() => renderToHtml(h(Modal, null, 'x'), { islands: collector }))).toBe(
      'X_ISLAND_NOT_HYDRATED',
    );
  });

  test('the two causes get one instruction each, and it is the reader’s own', async () => {
    // Declared and drained: the route reached `'never'` because someone wrote it.
    const Stated = island({ src: `./contact-modal${ISLAND_EXTENSION}` });
    const stated = defineRoute({ render: 'static', offline: 'precache', hydrate: 'never', meta });
    expect(stated.islands).toHaveLength(1);
    const statedFix = await fixOf(() =>
      renderToHtml(h(Stated, null, 'x'), {
        islands: createIslandCollector({ file: PAGE, hydrate: stated.hydrate }),
      }),
    );
    expect(statedFix).toContain("remove hydrate: 'never'");
    expect(statedFix).not.toContain('above defineRoute');

    // Declared below the route, so nothing drained it: the route never saw the island at all.
    const orphan = defineRoute({ render: 'static', offline: 'precache', meta });
    const Orphan = island({ src: `./search${ISLAND_EXTENSION}` });
    expect(orphan.islands).toHaveLength(0);
    expect(orphan.hydrate).toBe('never');
    const orphanFix = await fixOf(() =>
      renderToHtml(h(Orphan, null, 'x'), {
        islands: createIslandCollector({ file: PAGE, hydrate: orphan.hydrate }),
      }),
    );
    expect(orphanFix).toContain('above defineRoute');
    expect(orphanFix).not.toContain("remove hydrate: 'never'");
  });
});
