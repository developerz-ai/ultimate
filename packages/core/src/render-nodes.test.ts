// The walker, tested for the one thing that defeats it: recognising NEITHER node shape — the render
// factory's or one built by hand — is what falls through to nothing and leaves an assertion with
// an empty array, or (in a serialiser) with `"[object Object]"`.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from './errors';
import { HOLE_NODE, ISLAND_NODE, JSX_NODE } from './render-node';
import {
  attachRef,
  byComponent,
  byTag,
  fire,
  isRenderNode,
  nodesOf,
  one,
  type RenderComponent,
  type RenderNode,
  renderNodes,
  withAttr,
} from './render-nodes';

/** A hand-built node, the `{ inert: true }` shape a test writes when it renders nothing. */
function h(
  type: string | RenderComponent,
  props: Record<string, unknown> | null,
  ...children: readonly unknown[]
): RenderNode {
  const base = { ...(props ?? {}) };
  if (children.length > 0) base['children'] = children.length === 1 ? children[0] : children;
  return { inert: true, type, props: base } as RenderNode;
}

/** The factory's own shape: branded with the global symbol `@ultimat3/render`'s `h` stamps. */
const branded = (type: string | RenderComponent, props: Record<string, unknown>): RenderNode =>
  ({ [JSX_NODE]: true, type, props }) as RenderNode;

const names = (nodes: readonly RenderNode[]): string[] =>
  nodes.map((node) => (typeof node.type === 'function' ? node.type.name : node.type));

const Leaf = (props: Record<string, unknown>): unknown => h('em', null, props['label']);
const Wrapper = (props: Record<string, unknown>): unknown =>
  h('div', { class: 'wrap' }, props['children']);
// A component whose output is a thunk: renders nothing until something calls it.
const Lazy = (): unknown => () => branded('span', {});

const tree = (): RenderNode => h(Wrapper, null, h(Leaf, { label: 'x' }), branded(Lazy, {}));

describe('the node shape', () => {
  test('both factories are recognised, and nothing else', () => {
    expect(isRenderNode(h('p', null))).toBe(true);
    expect(isRenderNode(branded('p', {}))).toBe(true);
    expect(isRenderNode({ [Symbol.for('ultimate.render.jsx')]: true, type: 'p', props: {} })).toBe(
      true,
    );
    expect(isRenderNode({ type: 'p', props: {} })).toBe(false);
    expect(isRenderNode(null)).toBe(false);
    expect(isRenderNode('a string')).toBe(false);
  });
});

describe('the three component modes', () => {
  test("'expand', the default, calls components and keeps only host nodes", () => {
    expect(names(nodesOf(tree()))).toEqual(['div', 'em', 'span']);
    expect(names(nodesOf(tree(), { components: 'expand' }))).toEqual(['div', 'em', 'span']);
  });

  test("'keep' calls components and keeps each component node beside its output", () => {
    expect(names(nodesOf(tree(), { components: 'keep' }))).toEqual([
      'Wrapper',
      'div',
      'Leaf',
      'em',
      'Lazy',
      'span',
    ]);
  });

  test("'stop' calls no component, but still walks the children it was handed", () => {
    const nodes = nodesOf(tree(), { components: 'stop' });
    expect(names(nodes)).toEqual(['Wrapper', 'Leaf', 'Lazy']);
    expect(byTag(nodes, 'div')).toHaveLength(0);
  });

  test('renderNodes calls the component with the props given, in the mode given', () => {
    expect(names(renderNodes(Leaf, { label: 'hello' }))).toEqual(['em']);
    expect(names(renderNodes(Wrapper, { children: h(Leaf, {}) }, { components: 'keep' }))).toEqual([
      'div',
      'Leaf',
      'em',
    ]);
    expect(names(renderNodes(Wrapper, { children: h(Leaf, {}) }, { components: 'stop' }))).toEqual([
      'div',
      'Leaf',
    ]);
  });

  test('renderNodes refuses a value that is not a component, with X_INVARIANT', () => {
    const thrown = (() => {
      try {
        renderNodes({ notAComponent: true });
      } catch (error) {
        return error;
      }
      return expect.unreachable('renderNodes accepted an object');
    })();
    expect(thrown).toBeInstanceOf(UltimateError);
    expect((thrown as UltimateError).code).toBe('X_INVARIANT');
  });
});

describe('what contributes no node', () => {
  test('a thunk is invoked, an array is flattened, and a primitive contributes nothing', () => {
    expect(nodesOf(() => h('p', null))).toHaveLength(1);
    expect(nodesOf([h('p', null), h('span', null)])).toHaveLength(2);
    for (const value of [null, undefined, true, false, 'text', 7]) {
      expect(nodesOf(value)).toEqual([]);
    }
  });

  test("an island's server shell is walked, though the node is an array", () => {
    // render's island node is a BRANDED ARRAY: the array branch alone walks nothing, and the shell
    // an island renders before its chunk loads disappears from every query.
    const island = Object.assign([] as never[], {
      [ISLAND_NODE]: true as const,
      props: { label: 'x', children: h('dl', null, h('dd', null, 'en')) },
    });
    expect(names(nodesOf(h('div', null, island)))).toEqual(['div', 'dl', 'dd']);
    expect(Symbol.keyFor(ISLAND_NODE)).toBe('ultimate.render.island');
  });

  test('a hole is its first flush: fallback and error walked, deferred children never called', () => {
    let called = 0;
    const deferred = (): Promise<unknown> => {
      called += 1;
      return Promise.reject(new TypeError('a deferred subtree the walker must not start'));
    };
    const hole = Object.assign([] as never[], {
      [HOLE_NODE]: true as const,
      props: { fallback: h('i', null), error: h('b', null), children: deferred },
    });
    expect(names(nodesOf(h('div', null, hole)))).toEqual(['div', 'i', 'b']);
    expect(called).toBe(0);
    expect(Symbol.keyFor(HOLE_NODE)).toBe('ultimate.render.hole');
  });

  test('an unknown object falls through to nothing, never a node and never a string', () => {
    for (const mode of ['expand', 'keep', 'stop'] as const) {
      expect(nodesOf({ plain: true }, { components: mode })).toEqual([]);
      expect(nodesOf(h('p', null, { plain: true }), { components: mode })).toHaveLength(1);
    }
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

  test('byComponent reads the component function name', () => {
    const kept = nodesOf(tree(), { components: 'keep' });
    expect(byComponent(kept, 'Leaf')).toHaveLength(1);
    expect(byComponent(kept, 'em')).toHaveLength(0);
  });

  test('one() refuses zero and two, naming what it sought, with X_INVARIANT', () => {
    expect(() => one(byTag(nodes, 'a'), 'the link')).toThrow(
      'expected exactly one the link, found 2',
    );
    expect(() => one(byTag(nodes, 'form'), 'the form')).toThrow(
      'expected exactly one the form, found 0',
    );
    expect(() => one([], 'anything')).toThrow(UltimateError);
    expect(one(byTag(nodes, 'button'), 'the button').type).toBe('button');
  });

  test('fire() names the handler a node does not carry, and calls one it does', () => {
    expect(() => fire(one(byTag(nodes, 'button'), 'the button'), 'onInput', {})).toThrow(
      '<button> carries no onInput',
    );
    const seen: unknown[] = [];
    fire(h('button', { onClick: (event: unknown) => seen.push(event) }), 'onClick', { key: 'a' });
    expect(seen).toEqual([{ key: 'a' }]);
  });

  test('attachRef names a ref-less node by its component name, and hands a ref its element', () => {
    expect(() => attachRef(h(Leaf, {}), {})).toThrow('<Leaf> carries no ref');
    const seen: unknown[] = [];
    const element = { focus: () => undefined };
    attachRef(h('input', { ref: (el: unknown) => seen.push(el) }), element);
    expect(seen).toEqual([element]);
  });
});
