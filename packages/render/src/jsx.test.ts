import { describe, expect, test } from 'bun:test';
import { JSX_NODE } from '@ultimat3/core/render-node';
import { Fragment, h, isJsxNode } from './jsx';

describe('h', () => {
  test('marks the node so a renderer can tell it from a plain object', () => {
    const node = h('div', null);
    expect(isJsxNode(node)).toBe(true);
    expect(isJsxNode({ type: 'div', props: {} })).toBe(false);
    expect(node[JSX_NODE]).toBe(true);
  });

  test('the brand is the GLOBAL symbol, so every copy of a walker agrees on a node', () => {
    // Widened: `toBe` takes the `unique symbol` type of its subject, which no `Symbol.for` has.
    const brand: symbol = JSX_NODE;
    expect(brand).toBe(Symbol.for('ultimate.render.jsx'));
  });

  test('a single child is stored unwrapped, several become an array', () => {
    expect(h('p', null, 'one').props).toEqual({ children: 'one' });
    expect(h('p', null, 'one', 'two').props).toEqual({ children: ['one', 'two'] });
  });

  test('no children leaves props untouched, so `children` stays absent', () => {
    expect(h('br', { id: 'x' }).props).toEqual({ id: 'x' });
    expect('children' in h('br', { id: 'x' }).props).toBe(false);
  });

  test('rest children win over a declared children prop', () => {
    expect(h('p', { children: 'declared' }, 'rest').props).toEqual({ children: 'rest' });
  });

  test('a null props argument is an empty bag, never a crash', () => {
    expect(h('div', null).props).toEqual({});
  });
});

describe('Fragment', () => {
  test('is its children and nothing else', () => {
    expect(Fragment({ children: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(Fragment({})).toBeUndefined();
  });
});
