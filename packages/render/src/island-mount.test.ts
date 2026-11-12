// `mountOver` over the fake DOM: a draw that succeeds replaces the server markup, one that throws
// leaves it exactly as it was — the same nodes, in order, with the draw's half-insert taken out —
// and the throw reaches the caller once, so the runtime marks the island failed.
import { describe, expect, test } from 'bun:test';
import { mountOver } from './island-mount';
import { type FakeElement, h } from './navigation-dom-fixture';

const html = (node: FakeElement) => node as unknown as HTMLElement;
const fake = (node: HTMLElement) => node as unknown as FakeElement;

/** A wrapper holding what the server rendered: two nodes, so order is observable. */
const serverIsland = (): { el: FakeElement; markup: readonly FakeElement[] } => {
  const markup = [h('span', {}, 'shell'), h('button', { type: 'button' }, 'Open')];
  const el = h('div', { 'data-x-island': 'counter' }, markup);
  // The one DOM call the repair makes that this fixture does not carry; Solid's own is the same.
  Object.assign(el, { appendChild: (node: FakeElement) => el.append(node) });
  return { el, markup };
};

class DrawFailed extends TypeError {}

describe('mountOver', () => {
  test('a draw that succeeds replaces the server markup and answers its disposer', () => {
    const { el } = serverIsland();
    let disposed = 0;
    const dispose = mountOver(html(el), (root) => {
      fake(root).append(h('output', {}, 'live'));
      return () => {
        disposed += 1;
      };
    });
    expect(el.childNodes.map((node) => node.tagName)).toEqual(['OUTPUT']);
    dispose();
    expect(disposed).toBe(1);
  });

  test('the draw receives an EMPTY wrapper: Solid appends, so a kept shell would show twice', () => {
    const { el } = serverIsland();
    let seen = -1;
    mountOver(html(el), (root) => {
      seen = root.childNodes.length;
      return () => undefined;
    });
    expect(seen).toBe(0);
  });

  test('a draw that throws leaves the server markup in place, in order, and rethrows once', () => {
    const { el, markup } = serverIsland();
    const thrown = new DrawFailed('render threw');
    const caught: unknown[] = [];
    try {
      mountOver(html(el), (root) => {
        // What Solid does when a child component throws mid-render: part of the tree is in.
        fake(root).append(h('p', {}, 'half'));
        throw thrown;
      });
    } catch (error) {
      caught.push(error);
    }
    expect(caught).toEqual([thrown]);
    // The SAME nodes, not copies: listeners and focus the server markup carried survive.
    expect(el.childNodes).toEqual([...markup]);
    expect(el.textContent).toBe('shellOpen');
  });
});
