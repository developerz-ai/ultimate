// The fixture's own contract, against modules written in the exact idiom `babel-preset-solid`
// emits — a `<template>` whose `innerHTML` is parsed, `importNode`, a `firstChild`/`nextSibling`
// walk, a text node updated through `.data`, and a delegated `$$click`. No bundler and no Solid
// runtime here on purpose: `@ultimat3/testing` cannot import `@ultimat3/cli` (both tier 5, and the
// one declared edge runs the other way), and the whole-chain proof — real Babel, real Solid, a
// real island — is `examples/dummy/apps/web/app/settings/settings.island.test.ts`.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { IslandBuilder } from './fixture-island';
import { mountIsland } from './fixture-island';
import { testName } from './test-types';

const FILE = 'apps/web/site/counter.island.tsx';
const ROOT = '/tmp/island-fixture-root';

/** A builder is a function of the app root — the seam `buildIslands` fills in a real app. */
const builderOf = (chunks: readonly { file: string; code: string }[]): IslandBuilder => {
  return (root: string) => Promise.resolve({ chunks: root === ROOT ? chunks : [] });
};

/**
 * The markup half of a compiled island: a parsed `<template>`, cloned per mount. Written by hand
 * rather than generated, so this file states what the micro-DOM must support instead of inheriting
 * it from whatever the bundler happened to emit today.
 */
const PRELUDE = `const _tmpl$ = (() => {
  const t = document.createElement('template');
  t.innerHTML = '<div class="zero"><button type="button" data-role="bump">go</button><p data-role="count"> </p></div>';
  return t.content.firstChild;
})();
`;

/** Reactive: every click repaints the text node, the class property and the document attribute. */
const LIVE_ISLAND = `${PRELUDE}
export function mount(el, props) {
  el.textContent = '';
  const root = document.importNode(_tmpl$, true);
  const button = root.firstChild;
  const text = button.nextSibling.firstChild;
  let n = 0;
  const paint = () => {
    text.data = props.label + ' ' + n;
    root.className = n > 0 ? 'pos' : 'zero';
    if (n === 0) delete document.documentElement.dataset.clicked;
    else document.documentElement.dataset.clicked = String(n);
  };
  button.$$click = () => { n += 1; paint(); };
  paint();
  el.appendChild(root);
}
`;

/**
 * The same island with the repaint dropped from the handler: it renders once, correctly, and never
 * updates again — no throw, no log. That is the failure an eager JSX factory produces, and a
 * fixture that cannot tell it from LIVE_ISLAND proves nothing about any island.
 */
const DEAD_ISLAND = LIVE_ISLAND.replace('() => { n += 1; paint(); }', '() => { n += 1; }');

const POSTING_ISLAND = `export function mount(el, props) {
  el.textContent = '';
  const p = document.createElement('p');
  p.setAttribute('data-role', 'status');
  p.textContent = 'idle';
  el.appendChild(p);
  p.$$click = () => {
    fetch(props.endpoint, { method: 'POST', body: '{}' }).then((r) => {
      p.textContent = r.ok ? 'saved' : 'retry';
    });
  };
}
`;

/**
 * `solid-js/web`'s own `setStyleProperty`, verbatim (`web.js:302`). It is what
 * `babel-preset-solid` emits for every DYNAMIC entry of a `style={{ … }}` prop — checked against
 * the real transform, which turns `<Form style={{ '--form-gap': … }}>` into exactly this call and
 * bakes a static entry into the template's `style` attribute instead.
 */
const SET_STYLE_PROPERTY = `const setStyleProperty = (node, name, value) => {
  value != null ? node.style.setProperty(name, value) : node.style.removeProperty(name);
};
`;

/**
 * What a design-system component compiles to: one custom property painted per repaint, one
 * `classList.toggle` — the call the compiler emits INLINE for `classList={{ … }}`, with no runtime
 * helper in front of it — and one static declaration carried by the template.
 */
const STYLED_ISLAND = `${SET_STYLE_PROPERTY}
const _tmpl$ = (() => {
  const t = document.createElement('template');
  t.innerHTML = '<form class="form" style="display:grid"><button type="button" data-role="gap">go</button></form>';
  return t.content.firstChild;
})();

export function mount(el, props) {
  el.textContent = '';
  const root = document.importNode(_tmpl$, true);
  const button = root.firstChild;
  let step = props.gap;
  const paint = () => {
    setStyleProperty(root, '--form-gap', step === null ? null : 'var(--space-' + step + ')');
    root.classList.toggle('tight', step === 2);
  };
  button.$$click = () => { step = step === 5 ? 2 : null; paint(); };
  paint();
  el.appendChild(root);
}
`;

/** The other half of Solid's `style` runtime: a STRING style prop is `nodeStyle.cssText = value`,
 *  and clearing one is `setAttribute(node, 'style')` — which is `removeAttribute` (`web.js:237`). */
const CSS_TEXT_ISLAND = `export function mount(el, props) {
  el.textContent = '';
  const box = document.createElement('div');
  box.setAttribute('data-role', 'box');
  box.style.cssText = props.css;
  box.$$click = () => { box.removeAttribute('style'); };
  el.appendChild(box);
}
`;

/** `@ultimat3/ui`'s Menu, Popover and focus trap all close on Escape from a listener registered on
 *  `document` (`packages/ui/src/a11y.ts:118`), never on their own node. */
const ESCAPABLE_ISLAND = `export function mount(el) {
  el.textContent = '';
  const p = document.createElement('p');
  p.setAttribute('data-role', 'state');
  p.textContent = 'open';
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') p.textContent = 'closed';
  });
  el.appendChild(p);
}
`;

const mount = (code: string, props: unknown, extra: Record<string, unknown> = {}) =>
  mountIsland({
    build: builderOf([{ file: FILE, code }]),
    root: ROOT,
    file: FILE,
    props,
    ...extra,
  });

const codeOf = (error: unknown): string =>
  error instanceof UltimateError ? error.code : `not an UltimateError: ${String(error)}`;

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

/**
 * The micro-DOM's write surfaces, driven the way compiled Solid drives them. `style` was `{}` and
 * `classList` was `{ add() {} }` until 2026-08-21: `<Form>`, `<Stack>`, `<Grid>` and `<Container>`
 * all set a CSS custom property, so every one of them died inside `mount` with
 * `e.style.setProperty is not a function` — and `x g resource` emitted a plain `<form>` rather than
 * the design system's, because of what a TEST DOUBLE could not run.
 */
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

describe(testName('unit', 'the chunk is imported from a file, never a data: URL'), () => {
  // A source rule, because the failure it guards is invisible to `bun test`: `bun test --coverage`
  // panics with `range end index N out of range for slice of length 4096` on `import()` of any
  // `data:` module over ~4 kB, and every island chunk is 12-55 kB. Only the per-package CI job runs
  // coverage, so the whole suite went green locally while `package (cli)` and `package (testing)`
  // dumped core. The `data:` form reads better and is the one to reach for again; this is what says
  // no. Measured on Bun 1.4.0 — delete this the day that panic is fixed upstream.
  const source = (): Promise<string> => Bun.file(`${import.meta.dir}/fixture-island.ts`).text();

  test('the module specifier the fixture builds is a path', async () => {
    expect(await source()).not.toContain('data:text/javascript');
  });

  test('and the pattern that would see it is really in the file to be seen', async () => {
    // Negative control: a rule matching a string no version of the file ever held cannot fail.
    expect(await source()).toContain('moduleUrlFor');
  });
});
