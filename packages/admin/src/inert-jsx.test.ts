// The walkers, tested for the one thing that defeats them: recognising NEITHER node shape — the
// render factory's or a hand-built `h()` — is what falls through to `String(value)` and asserts
// against `"[object Object]"`.

import { describe, expect, test } from 'bun:test';
import {
  byComponent,
  byTag,
  fire,
  h,
  isInertNode,
  nodesOf,
  one,
  renderComponent,
  renderHtml,
  renderNodes,
  shallowNodesOf,
  withAttr,
} from './inert-jsx-fixture';

describe('the node shape', () => {
  test('h() puts a single child under props.children and several as an array', () => {
    expect(h('p', null, 'one').props['children']).toBe('one');
    expect(h('p', null, 'one', 'two').props['children']).toEqual(['one', 'two']);
    // No children at all: the key is absent, not an empty array a walker would descend into.
    expect('children' in h('br', null).props).toBe(false);
  });

  test('isInertNode recognises BOTH factories, and nothing else', () => {
    expect(isInertNode(h('p', null))).toBe(true);
    // `@ultimat3/render`'s brand, read off the global symbol registry.
    expect(isInertNode({ [Symbol.for('ultimate.render.jsx')]: true, type: 'p', props: {} })).toBe(
      true,
    );
    expect(isInertNode({ type: 'p', props: {} })).toBe(false);
    expect(isInertNode(null)).toBe(false);
    expect(isInertNode('a string')).toBe(false);
  });
});

describe('the walkers', () => {
  const Leaf = (props: Record<string, unknown>): unknown => h('em', null, props['label']);
  const Wrapper = (props: Record<string, unknown>): unknown =>
    h('div', { class: 'wrap' }, props['children']);

  test('nodesOf CALLS nested components and keeps the component node beside its output', () => {
    const nodes = nodesOf(h(Wrapper, null, h(Leaf, { label: 'x' })));
    expect(
      nodes.map((node) => (typeof node.type === 'function' ? node.type.name : node.type)),
    ).toEqual(['Wrapper', 'div', 'Leaf', 'em']);
  });

  test('shallowNodesOf stops at the component boundary', () => {
    const nodes = shallowNodesOf(h(Wrapper, null, h(Leaf, { label: 'x' })));
    expect(byTag(nodes, 'div')).toHaveLength(0);
    expect(byComponent(nodes, 'Wrapper')).toHaveLength(1);
    // The children are still walked — they are `props.children`, not the component's output.
    expect(byComponent(nodes, 'Leaf')).toHaveLength(1);
  });

  test('a thunk is invoked, an array is flattened, and a primitive contributes no node', () => {
    expect(nodesOf(() => h('p', null))).toHaveLength(1);
    expect(nodesOf([h('p', null), h('span', null)])).toHaveLength(2);
    for (const value of [null, undefined, true, false, 'text', 7, { plain: true }]) {
      expect(nodesOf(value)).toEqual([]);
    }
  });

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

  test('renderHtml falls back to String() only for a value no factory produced', () => {
    // The premise every render assertion rests on: an unrecognised object reaching here is what
    // used to make a suite assert against "[object Object]" without noticing.
    expect(renderHtml({ notANode: true })).toBe('[object Object]');
  });

  test('renderNodes and renderComponent call the component with the props given', () => {
    expect(renderComponent(Leaf, { label: 'hello' })).toBe('<em>hello</em>');
    expect(renderNodes(Leaf, { label: 'hello' }).map((node) => node.type)).toEqual(['em']);
  });
});

describe('the selectors fail loudly rather than silently', () => {
  const nodes = nodesOf([
    h('a', { href: '/one' }),
    h('a', { href: '/two' }),
    h('button', { onClick: () => undefined }),
  ]);

  test('withAttr matches presence with no value, and equality with one', () => {
    expect(withAttr(nodes, 'href')).toHaveLength(2);
    expect(withAttr(nodes, 'href', '/two')).toHaveLength(1);
    expect(withAttr(nodes, 'href', '/three')).toHaveLength(0);
  });

  test('one() throws with the count it found, rather than answering undefined', () => {
    expect(() => one(byTag(nodes, 'a'), 'the link')).toThrow(
      'expected exactly one the link, found 2',
    );
    expect(() => one(byTag(nodes, 'form'), 'the form')).toThrow(
      'expected exactly one the form, found 0',
    );
    expect(one(byTag(nodes, 'button'), 'the button').type).toBe('button');
  });

  test('fire() names the handler a node does not carry', () => {
    expect(() => fire(one(byTag(nodes, 'button'), 'the button'), 'onInput', {})).toThrow(
      '<button> carries no onInput',
    );
  });

  test('fire() calls the handler with the event it was given', () => {
    const seen: unknown[] = [];
    const node = h('button', { onClick: (event: unknown) => seen.push(event) });
    fire(node, 'onClick', { key: 'Enter' });
    expect(seen).toEqual([{ key: 'Enter' }]);
  });
});
