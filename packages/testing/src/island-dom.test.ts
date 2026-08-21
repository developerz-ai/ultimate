// The micro-DOM's own contract, driven through `mountIsland` rather than by calling its methods.
// A test that pokes the double proves the double matches itself; an island proves it matches what
// Solid — and an app's own hand-written `mount` — actually does to it.

import { describe, expect, test } from 'bun:test';
import type { IslandBuilder } from './fixture-island';
import { mountIsland } from './fixture-island';
import { testName } from './test-types';

const FILE = 'apps/web/site/counter.island.tsx';
const ROOT = '/tmp/island-dom-root';

const builderOf = (chunks: readonly { file: string; code: string }[]): IslandBuilder => {
  return (root: string) => Promise.resolve({ chunks: root === ROOT ? chunks : [] });
};

const mount = (code: string, props: unknown, extra: Record<string, unknown> = {}) =>
  mountIsland({
    build: builderOf([{ file: FILE, code }]),
    root: ROOT,
    file: FILE,
    props,
    ...extra,
  });

describe(testName('unit', 'the node surface Solid reconciles a list through'), () => {
  // `insertBefore`, `replaceChild`, `removeChild`, `remove` and a deep `cloneNode` are not
  // decoration: they are what `reconcileArrays` calls when a `<For>` re-orders, and a text node's
  // `.data`/`textContent` pair is how every reactive string lands. Driven through `mount`, not
  // called directly — a test that pokes the double's methods proves the double matches itself,
  // where an island proves it matches what Solid does to it.
  const LIST_ISLAND = `const _row$ = (() => {
  const t = document.createElement('template');
  t.innerHTML = '<li> </li>';
  return t.content.firstChild;
})();

export function mount(el, props) {
  el.textContent = '';
  const list = document.createElement('ul');
  const rowFor = (label) => {
    const row = document.importNode(_row$, true);
    row.firstChild.data = label;
    return row;
  };
  for (const label of props.items) list.appendChild(rowFor(label));
  el.appendChild(list);

  list.addEventListener('x-prepend', () => list.insertBefore(rowFor('first'), list.firstChild));
  list.addEventListener('x-swap', () => list.replaceChild(rowFor('swapped'), list.children[1]));
  list.addEventListener('x-drop', () => list.removeChild(list.children[0]));
  list.addEventListener('x-self-remove', () => list.children[0].remove());
  list.addEventListener('x-retext', () => {
    list.children[0].firstChild.textContent = 'retexted';
  });
}
`;

  const labels = (island: { all: (sel: string) => readonly { textContent: string }[] }): string[] =>
    island.all('li').map((row) => row.textContent);

  test('a deep cloneNode gives each row its own text node', async () => {
    using island = await mount(LIST_ISLAND, { items: ['a', 'b', 'c'] });

    // Three rows off one template. A shallow clone would give them one shared node and all three
    // would read 'c' — the bug a per-row assertion catches and a length assertion does not.
    expect(labels(island)).toEqual(['a', 'b', 'c']);
  });

  test('insertBefore puts a row at the head, not the tail', async () => {
    using island = await mount(LIST_ISLAND, { items: ['a', 'b'] });

    expect(island.fire('ul', 'x-prepend')).toBe(true);
    expect(labels(island)).toEqual(['first', 'a', 'b']);
  });

  test('replaceChild swaps in place and leaves the length alone', async () => {
    using island = await mount(LIST_ISLAND, { items: ['a', 'b', 'c'] });

    expect(island.fire('ul', 'x-swap')).toBe(true);
    expect(labels(island)).toEqual(['a', 'swapped', 'c']);
  });

  test('removeChild and a node removing itself agree', async () => {
    using island = await mount(LIST_ISLAND, { items: ['a', 'b', 'c'] });

    expect(island.fire('ul', 'x-drop')).toBe(true);
    expect(labels(island)).toEqual(['b', 'c']);

    // `remove()` routes through the parent's `removeChild`; a node that kept a stale `parentNode`
    // would drop the wrong row or none.
    expect(island.fire('ul', 'x-self-remove')).toBe(true);
    expect(labels(island)).toEqual(['c']);
  });

  test('a text node reads back through textContent, not only .data', async () => {
    using island = await mount(LIST_ISLAND, { items: ['a', 'b'] });

    expect(island.fire('ul', 'x-retext')).toBe(true);
    expect(labels(island)).toEqual(['retexted', 'b']);
  });
});

describe(testName('unit', 'a fragment template: importNode over the content node itself'), () => {
  // `babel-preset-solid` emits `_tmpl$ = t.content.firstChild` for a single-root template and
  // clones the CONTENT node for a fragment — two roots, no wrapper. That second shape reaches
  // `FakeNode.cloneNode` rather than `FakeElement`'s override, and nothing else in this suite does.
  const FRAGMENT_ISLAND = `const _tmpl$ = (() => {
  const t = document.createElement('template');
  t.innerHTML = '<h2 data-role="head">head</h2><p data-role="body">body</p>';
  return t.content;
})();

export function mount(el, props) {
  el.textContent = '';
  const frag = document.importNode(_tmpl$, true);
  for (const child of [...frag.childNodes]) el.appendChild(child);
  el.querySelector('[data-role="head"]').firstChild.data = props.title;
}
`;

  test('both roots arrive, and the clone is deep', async () => {
    using island = await mount(FRAGMENT_ISLAND, { title: 'Settings' });

    expect(island.text('[data-role="head"]')).toBe('Settings');
    // The second root proves it cloned the content node's whole child list, not just the first.
    expect(island.text('[data-role="body"]')).toBe('body');
  });

  test('the template itself is untouched, so a second mount is not a rerun', async () => {
    using first = await mount(FRAGMENT_ISLAND, { title: 'One' });
    expect(first.text('[data-role="head"]')).toBe('One');

    // A shallow clone would have handed both mounts the SAME text node and this would read 'One'.
    using second = await mount(FRAGMENT_ISLAND, { title: 'Two' });
    expect(second.text('[data-role="head"]')).toBe('Two');
  });

  test('an element answers nodeName uppercased, as the DOM does', async () => {
    using island = await mount(FRAGMENT_ISLAND, { title: 'Settings' });

    // `find` returns the double, and an island that branches on `nodeName` — the DOM's own
    // spelling, always uppercase, unlike `tagName` here — must not see the source casing.
    expect(island.find('[data-role="head"]')?.nodeName).toBe('H2');
  });
});

describe(
  testName('unit', 'the DOM surface an app island uses directly, not only the one Solid emits'),
  () => {
    // `classList.add/remove/contains`, `hasAttribute` and the `cssText` getter are not in Solid's
    // compiled output — `toggle` and `setProperty` are. They are here for the island an app writes
    // by hand, so they are driven the way an app would drive them: through `mount`.
    const HANDWRITTEN_ISLAND = `export function mount(el, props) {
  el.textContent = '';
  const box = document.createElement('div');
  box.setAttribute('data-role', 'box');
  box.classList.add('card');
  box.style.setProperty('--gap', props.gap);
  el.appendChild(box);

  box.addEventListener('x-select', () => {
    box.classList.add('selected');
    box.setAttribute('aria-selected', 'true');
  });
  box.addEventListener('x-clear', () => {
    box.classList.remove('selected');
    box.removeAttribute('aria-selected');
  });
  box.addEventListener('x-report', () => {
    box.setAttribute('data-report', [
      box.classList.contains('selected') ? 'on' : 'off',
      box.hasAttribute('aria-selected') ? 'flagged' : 'plain',
      box.style.cssText,
    ].join('|'));
  });
}
`;

    const report = async (events: readonly string[]): Promise<string> => {
      using island = await mount(HANDWRITTEN_ISLAND, { gap: '8px' });
      for (const event of events) expect(island.fire('[data-role="box"]', event)).toBe(true);
      expect(island.fire('[data-role="box"]', 'x-report')).toBe(true);
      return island.find('[data-role="box"]')?.getAttribute('data-report') ?? '';
    };

    test('add, hasAttribute and the cssText getter agree after a select', async () => {
      expect(await report(['x-select'])).toBe('on|flagged|--gap: 8px;');
    });

    test('remove and removeAttribute undo it, and the declaration survives', async () => {
      // The style is untouched by either handler: a `classList` change that reset the declarations
      // would be a shared-representation bug, which is the one this backing choice exists to avoid.
      expect(await report(['x-select', 'x-clear'])).toBe('off|plain|--gap: 8px;');
    });

    test('contains answers false for a class the element never had', async () => {
      expect(await report([])).toBe('off|plain|--gap: 8px;');
    });
  },
);

describe(testName('unit', 'a document listener an island installs, and takes back'), () => {
  // `@ultimat3/ui`'s Menu, Popover and `a11y.ts` all close on an Escape registered on `document`,
  // never on their own node — so an island test that cannot drive the document cannot close them,
  // and one that cannot see the REMOVAL cannot tell a clean unmount from a leak. Both halves are
  // modelled, and `documentElement` is where both land.
  const DISMISSIBLE_ISLAND = `export function mount(el, props) {
  el.textContent = '';
  const panel = document.createElement('div');
  panel.setAttribute('data-role', 'panel');
  panel.setAttribute('data-open', 'true');
  el.appendChild(panel);

  const onKey = () => panel.setAttribute('data-open', 'false');
  document.addEventListener('keydown', onKey);
  panel.addEventListener('x-unmount', () => document.removeEventListener('keydown', onKey));
}
`;

  const openState = (island: {
    find: (s: string) => { getAttribute: (n: string) => string | null } | null;
  }): string | null => island.find('[data-role="panel"]')?.getAttribute('data-open') ?? null;

  test('Escape on the document closes the panel', async () => {
    using island = await mount(DISMISSIBLE_ISLAND, {});
    expect(openState(island)).toBe('true');

    expect(island.fire(island.documentElement, 'keydown')).toBe(true);
    expect(openState(island)).toBe('false');
  });

  test('and after the island takes it back, the same key does nothing', async () => {
    using island = await mount(DISMISSIBLE_ISLAND, {});

    expect(island.fire('[data-role="panel"]', 'x-unmount')).toBe(true);
    // `false` is the whole point: a removal the double ignored would answer `true` here and the
    // panel would still close, so a leaking component would read as a clean one.
    expect(island.fire(island.documentElement, 'keydown')).toBe(false);
    expect(openState(island)).toBe('true');
  });
});
