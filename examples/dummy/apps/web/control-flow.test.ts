/**
 * Solid's control-flow components must render on the SERVER, through the framework's own inert
 * JSX factory. Nothing else in the repo asserts this, and the two halves are owned by different
 * projects: `@ultimat3/render`'s `h` builds inert nodes and may never import `solid-js`, while
 * `For`/`Show`/`Index` are Solid's and change shape across major versions.
 *
 * That seam is invisible until it breaks, and it breaks SILENTLY — a `For` the renderer cannot
 * walk emits an empty `<ul>`, not an error. Five pages in this app render lists that way, and a
 * blank feed is indistinguishable from a feed with no posts. It has already happened once: the
 * `solid-js@2.0.0-experimental` pin passed every gate while rendering nothing.
 *
 * `For` vs `Index` is the specific trap. `For` is keyed by value identity and hands the callback
 * the ITEM; `Index` is keyed by position and hands it an ACCESSOR. Solid 2 changed `For` to the
 * accessor shape, so a template written against it typechecks under one major and silently
 * renders nothing under the other. Both shapes are pinned below.
 */

import { describe, expect, test } from 'bun:test';
import { h } from '@ultimat3/render';
import { renderToHtml } from '@ultimat3/render/server';
import { For, Index, Show } from 'solid-js';

interface Row {
  readonly title: string;
}

const rows: readonly Row[] = [{ title: 'alpha' }, { title: 'beta' }];

// `h` is typed for the framework's own components; Solid's carry Solid's JSX types. The cast is
// the seam itself — it is what the assertions below exist to check at runtime.
const component = (value: unknown) => value as Parameters<typeof h>[0];

describe('solid control flow renders server-side', () => {
  test('For passes the ITEM, not an accessor, and emits one node per row', async () => {
    const node = h(
      'ul',
      null,
      h(component(For), { each: rows, fallback: h('li', null, 'empty') }, (row: Row) =>
        h('li', null, row.title),
      ),
    );
    expect(await renderToHtml(node)).toBe('<ul><li>alpha</li><li>beta</li></ul>');
  });

  test('For renders its fallback for an empty list', async () => {
    // The failure this catches is a renderer that emits `<ul></ul>` for BOTH an empty list and a
    // broken `For` — which is why the populated case above cannot stand alone.
    const node = h(
      'ul',
      null,
      h(component(For), { each: [], fallback: h('li', null, 'empty') }, (row: Row) =>
        h('li', null, row.title),
      ),
    );
    expect(await renderToHtml(node)).toBe('<ul><li>empty</li></ul>');
  });

  test('Index passes an ACCESSOR — the shape For must not have', async () => {
    const node = h(
      'ul',
      null,
      h(component(Index), { each: rows }, (row: () => Row) => h('li', null, row().title)),
    );
    expect(await renderToHtml(node)).toBe('<ul><li>alpha</li><li>beta</li></ul>');
  });

  test('Show renders its branch, and its fallback, rather than swallowing both', async () => {
    const shown = h(component(Show), { when: true, fallback: h('i', null, 'no') }, () =>
      h('b', null, 'yes'),
    );
    expect(await renderToHtml(shown)).toBe('<b>yes</b>');

    const hidden = h(component(Show), { when: false, fallback: h('i', null, 'no') }, () =>
      h('b', null, 'yes'),
    );
    expect(await renderToHtml(hidden)).toBe('<i>no</i>');
  });
});
