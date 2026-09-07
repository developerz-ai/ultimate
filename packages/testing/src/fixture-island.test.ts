// The fixture's own contract, against modules written in the exact idiom `babel-preset-solid`
// emits — a `<template>` whose `innerHTML` is parsed, `importNode`, a `firstChild`/`nextSibling`
// walk, a text node updated through `.data`, and a delegated `$$click`. No bundler and no Solid
// runtime here on purpose: `@ultimat3/testing` cannot import `@ultimat3/cli` (both tier 5, and the
// one declared edge runs the other way), and the whole-chain proof — real Babel, real Solid, a
// real island — is `examples/dummy/apps/web/app/settings/settings.island.test.ts`.

import { describe, expect, test } from 'bun:test';
import type { UltimateError } from '@ultimat3/core';
import { mountIsland } from './fixture-island';
import {
  ASYNC_ISLAND,
  builderOf,
  CSS_TEXT_ISLAND,
  codeOf,
  DEAD_ISLAND,
  ESCAPABLE_ISLAND,
  FILE,
  LIVE_ISLAND,
  mount,
  POSTING_ISLAND,
  ROOT,
  STYLED_ISLAND,
} from './fixture-island-fixtures.test';
import { testName } from './test-types';

describe(testName('unit', 'the island fixture mounts a compiled island'), () => {
  test('a reactive island repaints text, a class property and the document attribute', async () => {
    using mounted = await mount(LIVE_ISLAND, { label: 'count' });

    expect(mounted.text('[data-role="count"]')).toBe('count 0');
    expect(mounted.find('div')?.className).toBe('zero');
    expect('clicked' in mounted.documentElement.dataset).toBe(false);

    expect(mounted.fire('button', 'click')).toBe(true);

    // Text, attribute and the document write fail INDEPENDENTLY — a micro-DOM missing `Text.data`
    // keeps the class working while every text binding silently dies — so all three are asserted.
    expect(mounted.text('[data-role="count"]')).toBe('count 1');
    expect(mounted.find('div')?.className).toBe('pos');
    expect(mounted.documentElement.dataset['clicked']).toBe('1');
  });

  test('an island that renders once and never updates reads as exactly that', async () => {
    using mounted = await mount(DEAD_ISLAND, { label: 'count' });

    expect(mounted.text('[data-role="count"]')).toBe('count 0');
    // `true`: a handler DID run. The island moved nothing anyway, which is the whole distinction
    // between an island that is dead and a test whose selector matched nothing.
    expect(mounted.fire('button', 'click')).toBe(true);

    // The point of the fixture: driven identically, the dead island does NOT move. Were this
    // 'count 1' the fixture would be reporting its own driver rather than the island.
    expect(mounted.text('[data-role="count"]')).toBe('count 0');
    expect(mounted.find('div')?.className).toBe('zero');
  });

  test('the server shell goes in, and mount replaces it', async () => {
    using mounted = await mount(
      LIVE_ISLAND,
      { label: 'count' },
      {
        shell: '<dl><dt>Language</dt><dd>en</dd></dl>',
      },
    );

    // Solid's `render` APPENDS when the container already has children, so a shell left standing
    // is a second, uneditable copy of the same values above the real editor.
    expect(mounted.find('dl')).toBeNull();
    expect(mounted.all('button')).toHaveLength(1);
  });

  test('an async mount is finished before the fixture answers — no manual flush', async () => {
    // The shipped runtime AWAITS `mount` (`packages/render/src/hydrate.ts`'s `boot`), so an island
    // that opens a queue or a socket before rendering is a browser-legal island. The fixture called
    // it and returned, so every assertion below ran against an empty wrapper and every test of such
    // an island had to carry a hand-rolled `settle()` — the fixture answering for a browser it did
    // not match.
    using mounted = await mount(
      ASYNC_ISLAND,
      { label: 'ready' },
      {
        globals: {
          openQueue: () =>
            new Promise((resolve) => {
              setTimeout(() => {
                resolve({ depth: 0 });
              }, 0);
            }),
        },
      },
    );

    expect(mounted.text('[data-role="state"]')).toBe('0 ready');
    // Not just present: DRIVABLE. A mount awaited far enough to paint but not far enough to attach
    // its handlers would read as fixed here and still be inert.
    expect(mounted.fire('[data-role="state"]', 'click')).toBe(true);
    expect(mounted.text('[data-role="state"]')).toBe('clicked');
  });

  test('a global the micro-DOM does not supply reaches the island — fetch above all', async () => {
    const calls: string[] = [];
    using mounted = await mount(
      POSTING_ISLAND,
      { endpoint: '/api/settings/save' },
      {
        globals: {
          fetch: (url: string) => {
            calls.push(url);
            return Promise.resolve({ ok: true });
          },
        },
      },
    );

    mounted.fire('[data-role="status"]', 'click');
    await Promise.resolve();

    expect(calls).toEqual(['/api/settings/save']);
    expect(mounted.text('[data-role="status"]')).toBe('saved');
  });

  test('two mounts never share a document — dataset is state the next island would inherit', async () => {
    using first = await mount(LIVE_ISLAND, { label: 'a' });
    first.fire('button', 'click');
    expect(first.documentElement.dataset['clicked']).toBe('1');

    using second = await mount(LIVE_ISLAND, { label: 'b' });
    expect('clicked' in second.documentElement.dataset).toBe(false);
  });

  test('a global that refuses assignment takes the whole install back out with it', async () => {
    const KEY = 'ultimateIslandSealedProbe';
    Object.defineProperty(globalThis, KEY, { get: () => 'sealed', configurable: true });
    try {
      const thrown = await mount(
        LIVE_ISLAND,
        { label: 'count' },
        {
          globals: { [KEY]: 'fake' },
        },
      ).then(
        () => 'mounted',
        (error: unknown) => (error as Error).constructor.name,
      );

      expect(thrown).toBe('TypeError');
      // The DOM globals go in FIRST and the caller's own keys last, so the throw always lands with
      // a fake `document` already installed — and it lands AHEAD of `mountIsland`'s own `try`,
      // which is the one that would have taken it back out. Every later FILE in the run would
      // render against it, and fail somewhere with no thread back here.
      expect(Reflect.get(globalThis, 'document')).toBeUndefined();
      expect(Reflect.get(globalThis, 'Element')).toBeUndefined();
    } finally {
      Reflect.deleteProperty(globalThis, KEY);
    }
  });

  test('a global that exists holding undefined is restored, not deleted', async () => {
    const KEY = 'ultimateIslandUndefinedProbe';
    Reflect.set(globalThis, KEY, undefined);
    try {
      {
        using mounted = await mount(
          LIVE_ISLAND,
          { label: 'count' },
          { globals: { [KEY]: 'fake' } },
        );
        expect(mounted.text('[data-role="count"]')).toBe('count 0');
        expect(Reflect.get(globalThis, KEY)).toBe('fake');
      }

      // A saved VALUE cannot tell "no such global" from "a global holding undefined", so the
      // teardown deleted both — and `KEY in globalThis` flipped true to false behind the test that
      // owns it. A saved DESCRIPTOR distinguishes them; `undefined` is the absent one.
      expect(Object.hasOwn(globalThis, KEY)).toBe(true);
      expect(Reflect.get(globalThis, KEY)).toBeUndefined();
    } finally {
      Reflect.deleteProperty(globalThis, KEY);
    }
  });

  test('dispose hands the process back its own globals', async () => {
    const before = Reflect.get(globalThis, 'document');
    {
      using mounted = await mount(LIVE_ISLAND, { label: 'count' });
      expect(mounted.el.children).toHaveLength(1);
      expect(Reflect.get(globalThis, 'document')).not.toBe(before);
    }
    // Left installed, every LATER FILE in the run gets a fake `document` with no thread back here.
    expect(Reflect.get(globalThis, 'document')).toBe(before);
    // `undefined`, not "restored to what it was": Bun has no DOM, so the restore DELETES the key.
    expect(Reflect.get(globalThis, 'Element')).toBeUndefined();
  });
});

describe(testName('unit', 'the island fixture records what an island writes to an element'), () => {
  test('a custom property is recorded, repainted, and removed by name alone', async () => {
    using mounted = await mount(STYLED_ISLAND, { gap: 5 });
    const form = mounted.find('form');

    expect(form?.style.getPropertyValue('--form-gap')).toBe('var(--space-5)');
    // Swallowing the call is the same shape of hole as a click handler that never fires: no throw,
    // no log, and "the component set --form-gap" untestable by construction.
    expect(mounted.fire('button', 'click')).toBe(true);
    expect(form?.style.getPropertyValue('--form-gap')).toBe('var(--space-2)');

    mounted.fire('button', 'click');
    expect(form?.style.getPropertyValue('--form-gap')).toBe('');
    // The static declaration the TEMPLATE carried is untouched: `removeProperty` takes its own
    // entry, and a style attribute the parser read is the same declaration the island writes to.
    expect(form?.style.getPropertyValue('display')).toBe('grid');
  });

  test('the template style attribute and the style object are one declaration', async () => {
    using mounted = await mount(STYLED_ISLAND, { gap: 5 });

    // Two representations would let `getAttribute('style')` and `style.getPropertyValue` disagree
    // about the same element — and the browser answers both from one place.
    expect(mounted.find('form')?.getAttribute('style')).toBe(
      'display: grid; --form-gap: var(--space-5);',
    );
  });

  test('classList.toggle moves the class property the compiler also writes', async () => {
    using mounted = await mount(STYLED_ISLAND, { gap: 5 });
    const form = mounted.find('form');

    expect(form?.className).toBe('form');
    mounted.fire('button', 'click');
    // `classList` and `className` are the same attribute: a component using `classList={{ … }}`
    // and a test asserting `className` must not be looking at two different class lists.
    expect(form?.className).toBe('form tight');
    expect(form?.classList.contains('tight')).toBe(true);

    mounted.fire('button', 'click');
    expect(form?.className).toBe('form');
  });

  test('a string style prop lands as declarations, and removing the attribute clears them', async () => {
    using mounted = await mount(CSS_TEXT_ISLAND, { css: 'color: red; --gap: 2px' });
    const box = mounted.find('[data-role="box"]');

    expect(box?.style.getPropertyValue('--gap')).toBe('2px');
    expect(box?.style.getPropertyValue('color')).toBe('red');

    expect(mounted.fire('[data-role="box"]', 'click')).toBe(true);
    expect(box?.style.getPropertyValue('color')).toBe('');
    expect(box?.hasAttribute('style')).toBe(false);
  });

  test('a listener an island puts on document is drivable through documentElement', async () => {
    using mounted = await mount(ESCAPABLE_ISLAND, {});

    expect(mounted.text('[data-role="state"]')).toBe('open');
    // The document and its element share one listener book because this DOM has no bubbling at
    // all: an Escape handler registered on `document` and dropped on the floor is a Popover no
    // test can ever close.
    expect(mounted.fire(mounted.documentElement, 'keydown', { key: 'Escape' })).toBe(true);
    expect(mounted.text('[data-role="state"]')).toBe('closed');
  });
});

describe(testName('unit', 'the island fixture refuses by name'), () => {
  test('a file the build never produced is X_TEST_ISLAND_NOT_BUILT, listing what it did', async () => {
    const build = builderOf([{ file: 'apps/web/site/other.island.tsx', code: LIVE_ISLAND }]);
    const thrown = await mountIsland({ build, root: ROOT, file: FILE }).then(
      () => 'mounted',
      codeOf,
    );

    expect(thrown).toBe('X_TEST_ISLAND_NOT_BUILT');
  });

  test('the cause names the islands that WERE built, because a wrong root looks identical', async () => {
    const build = builderOf([{ file: 'apps/web/site/other.island.tsx', code: LIVE_ISLAND }]);
    let error: unknown;
    try {
      await mountIsland({ build, root: ROOT, file: FILE });
      expect.unreachable('a file outside the bundle must not mount');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeUltimateError('X_TEST_ISLAND_NOT_BUILT');
    expect((error as UltimateError).message).toContain('apps/web/site/other.island.tsx');
    // The empty-bundle branch says something different, and it is the more common mistake.
    const empty = await mountIsland({ build, root: '/elsewhere', file: FILE }).catch(
      (caught: unknown) => (caught as UltimateError).message,
    );
    expect(empty).toContain('no island was built');
  });

  test('a chunk with no mount export is X_TEST_ISLAND_NO_MOUNT, not a TypeError', async () => {
    // The island compiles, ships and is served; the browser throws on `m.mount is not a function`
    // long after every gate went green.
    const thrown = await mount('export const Counter = () => null;\n', {}).then(
      () => 'mounted',
      codeOf,
    );

    expect(thrown).toBe('X_TEST_ISLAND_NO_MOUNT');
  });

  test('a mount that throws still hands the globals back', async () => {
    const before = Reflect.get(globalThis, 'document');
    await mount('export function mount() { throw new TypeError("boom"); }\n', {}).catch(
      () => undefined,
    );

    expect(Reflect.get(globalThis, 'document')).toBe(before);
  });
});
