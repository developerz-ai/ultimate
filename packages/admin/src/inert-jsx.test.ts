// The fixture's own half, tested for the one thing that defeats it: recognising NEITHER node shape —
// the render factory's or a hand-built `h()` — is what falls through to `String(value)` and asserts
// against `"[object Object]"`. The walker's modes are `@ultimat3/core`'s `render-nodes.test.ts`.

import { describe, expect, test } from 'bun:test';
import { byComponent, byTag, isRenderNode, nodesOf } from '@ultimat3/core/render-nodes';
import { h, renderComponent, renderHtml } from './inert-jsx-fixture';

describe('the node shape', () => {
  test('h() puts a single child under props.children and several as an array', () => {
    expect(h('p', null, 'one').props['children']).toBe('one');
    expect(h('p', null, 'one', 'two').props['children']).toEqual(['one', 'two']);
    // No children at all: the key is absent, not an empty array a walker would descend into.
    expect('children' in h('br', null).props).toBe(false);
  });

  test('the public walker recognises a hand-built h() node', () => {
    expect(isRenderNode(h('p', null))).toBe(true);
  });
});

describe('the walker over a tree h() built, in the two modes admin reads', () => {
  const Leaf = (props: Record<string, unknown>): unknown => h('em', null, props['label']);
  const Wrapper = (props: Record<string, unknown>): unknown =>
    h('div', { class: 'wrap' }, props['children']);

  test("'keep' calls nested components and keeps the component node beside its output", () => {
    const nodes = nodesOf(h(Wrapper, null, h(Leaf, { label: 'x' })), { components: 'keep' });
    expect(
      nodes.map((node) => (typeof node.type === 'function' ? node.type.name : node.type)),
    ).toEqual(['Wrapper', 'div', 'Leaf', 'em']);
  });

  test("'stop' halts at the design-system boundary and still walks the children", () => {
    const nodes = nodesOf(h(Wrapper, null, h(Leaf, { label: 'x' })), { components: 'stop' });
    expect(byTag(nodes, 'div')).toHaveLength(0);
    expect(byComponent(nodes, 'Wrapper')).toHaveLength(1);
    expect(byComponent(nodes, 'Leaf')).toHaveLength(1);
  });
});

describe('the serialiser', () => {
  test('renderHtml skips handlers, refs and false attributes, and prints true bare', () => {
    const html = renderHtml(
      h('input', {
        name: 'title',
        disabled: false,
        required: true,
        ref: () => undefined,
        onInput: () => undefined,
        'aria-label': 'Title',
      }),
    );
    expect(html).toBe('<input name="title" required aria-label="Title"></input>');
  });

  test('renderHtml reads the render factory brand too', () => {
    const node = { [Symbol.for('ultimate.render.jsx')]: true, type: 'p', props: { children: 'x' } };
    expect(renderHtml(node)).toBe('<p>x</p>');
  });

  test('renderHtml falls back to String() only for a value no factory produced', () => {
    // The premise every render assertion rests on: an unrecognised object reaching here is what
    // used to make a suite assert against "[object Object]" without noticing.
    expect(renderHtml({ notANode: true })).toBe('[object Object]');
  });

  test('a thunk is invoked, an array is joined, and a component is called', () => {
    expect(renderHtml(() => h('p', null))).toBe('<p></p>');
    expect(renderHtml([h('p', null), 'x', 7])).toBe('<p></p>x7');
    const Leaf = (props: Record<string, unknown>): unknown => h('em', null, props['label']);
    expect(renderComponent(Leaf, { label: 'hello' })).toBe('<em>hello</em>');
  });
});
