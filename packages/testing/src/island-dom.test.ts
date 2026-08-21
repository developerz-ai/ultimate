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

describe(testName('unit', 'attaching a node MOVES it, as the DOM does'), () => {
  // The half `reconcileArrays` depends on and a stub reaches for last: `parentNode.insertBefore(b,
  // ref)` is called on a child ALREADY in that parent whenever a `<For>` re-orders
  // (`solid-js/web`'s `web.js:155`, `:163`, `:184`), and `a[i].remove()` is how it drops one. An
  // attach that does not detach first leaves the node in BOTH places, so the list grows a duplicate
  // per move; a remove that leaves `parentNode` set makes an orphan answer `nextSibling` with its
  // old parent's FIRST child instead of `null`.
  const MOVING_ISLAND = `export function mount(el, props) {
  const shellChild = el.firstChild;
  el.textContent = '';
  const list = document.createElement('ul');
  const spare = document.createElement('ol');
  const row = (label) => {
    const li = document.createElement('li');
    li.appendChild(document.createTextNode(label));
    return li;
  };
  for (const label of props.items) list.appendChild(row(label));
  el.appendChild(list);
  el.appendChild(spare);
  el.setAttribute('data-shell', String(shellChild !== null && shellChild.parentNode === null));

  const report = (value) => el.setAttribute('data-report', String(value));
  list.addEventListener('x-rotate', () => {
    list.insertBefore(list.children[list.children.length - 1], list.children[0]);
  });
  list.addEventListener('x-adopt', () => spare.appendChild(list.children[0]));
  list.addEventListener('x-swap', () => {
    const gone = list.replaceChild(row('new'), list.children[1]);
    report(gone.parentNode === null);
  });
  list.addEventListener('x-hoist', () => list.replaceChild(list.children[2], list.children[0]));
  list.addEventListener('x-self', () => list.insertBefore(list.children[0], list.children[0]));
  list.addEventListener('x-foreign', () => list.removeChild(spare.children[0]));
  list.addEventListener('x-drop', () => {
    const gone = list.removeChild(list.children[0]);
    report((gone.parentNode === null) + '|' + (gone.nextSibling === null));
  });
}
`;

  const labels = (island: { all: (sel: string) => readonly { textContent: string }[] }): string[] =>
    island.all('li').map((row) => row.textContent);

  const mountList = (shell?: string) =>
    mount(MOVING_ISLAND, { items: ['a', 'b', 'c'] }, shell === undefined ? {} : { shell });

  test('insertBefore re-orders a row already in the list instead of copying it', async () => {
    using island = await mountList();

    expect(island.fire('ul', 'x-rotate')).toBe(true);
    // Four rows here, not three, is the whole defect: `<For>` re-ordering a list of five would
    // leave ten, in an order no assertion could read back.
    expect(labels(island)).toEqual(['c', 'a', 'b']);
  });

  test('appendChild moves a row to another parent, it does not clone it', async () => {
    using island = await mountList();

    expect(island.fire('ul', 'x-adopt')).toBe(true);
    // Document order, and `all` walks the whole subtree: the moved row now reads LAST, after the
    // two it left behind. A copy would read `a, b, c, a` — the same node twice, in two parents.
    expect(labels(island)).toEqual(['b', 'c', 'a']);
  });

  test('replaceChild leaves the node it replaced with no parent', async () => {
    using island = await mountList();

    expect(island.fire('ul', 'x-swap')).toBe(true);
    expect(labels(island)).toEqual(['a', 'new', 'c']);
    expect(island.el.getAttribute('data-report')).toBe('true');
  });

  test('replaceChild with a row already in the list moves it, leaving two', async () => {
    // `reconcileArrays` calls `parentNode.replaceChild(b[i], a[j])` on nodes from the NEW list
    // (`web.js:185`), which for a keyed `<For>` re-order are already children of that parent — so
    // the node has to leave its old index. Without that, `a, b, c` replaced by its own third row
    // reads `c, b, c`: the same node twice, once where it never went.
    using island = await mountList();

    expect(island.fire('ul', 'x-hoist')).toBe(true);
    expect(labels(island)).toEqual(['c', 'b']);
  });

  test('a removed node is an orphan, so its nextSibling is null and not its old first sibling', async () => {
    using island = await mountList();

    expect(island.fire('ul', 'x-drop')).toBe(true);
    expect(labels(island)).toEqual(['b', 'c']);
    // `false|false` is what a filter-only removal answers, and the second half is the dangerous
    // one: `indexOf` of a node no longer in the array is -1, so `siblings[-1 + 1]` hands back the
    // list's new FIRST child as the orphan's next sibling.
    expect(island.el.getAttribute('data-report')).toBe('true|true');
  });

  test('a node asked to precede itself stays where it is', async () => {
    // The spec's own step — "if referenceChild is node, set referenceChild to node's next
    // sibling" — and without it the detach makes the reference unfindable and the row lands at the
    // END. A silent re-order of a list nobody asked to re-order.
    using island = await mountList();

    expect(island.fire('ul', 'x-self')).toBe(true);
    expect(labels(island)).toEqual(['a', 'b', 'c']);
  });

  test('removing a node that belongs to another parent takes nothing out of this one', async () => {
    using island = await mountList();
    expect(island.fire('ul', 'x-adopt')).toBe(true);

    // The DOM throws `NotFoundError` here; this answers a no-op. What it must NOT do is what an
    // unguarded `splice(indexOf(child), 1)` does with -1 — silently drop the LAST row instead.
    expect(island.fire('ul', 'x-foreign')).toBe(true);
    expect(labels(island)).toEqual(['b', 'c', 'a']);
  });

  test('clearing textContent detaches the shell it dropped', async () => {
    // `el.textContent = ''` opens every island's `mount` and closes Solid's own `render` disposer
    // (`web.js:201`), so a shell node that keeps its parent is a node two trees claim.
    using island = await mountList('<p>server</p>');

    expect(island.el.getAttribute('data-shell')).toBe('true');
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
