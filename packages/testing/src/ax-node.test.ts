// `toAxNode`, CDP's partial-tree answer for ONE element: its own node read into the shape a matcher
// asks, and an empty or absent answer kept as one ignored node rather than dropped.

import { describe, expect, test } from 'bun:test';
import { toAxNode } from './ax-node';

describe('toAxNode', () => {
  test("reads the element's own node: role, name, value, and the flags it carries", () => {
    const node = toAxNode({
      nodes: [
        {
          role: { type: 'role', value: 'button' },
          name: { type: 'computedString', value: 'Save' },
          value: { type: 'number', value: 3 },
          properties: [
            { name: 'focused', value: { type: 'boolean', value: true } },
            { name: 'disabled', value: { type: 'boolean', value: false } },
          ],
        },
        { role: { type: 'role', value: 'StaticText' }, name: { value: 'not this one' } },
      ],
    });
    expect(node).toEqual({
      role: 'button',
      name: 'Save',
      value: '3',
      focused: true,
      disabled: false,
      ignored: false,
    });
  });

  test('an element that never entered the tree is one ignored node, not nothing', () => {
    const ignored = { role: '', name: '', ignored: true };
    expect(toAxNode({ nodes: [] })).toEqual(ignored);
    expect(toAxNode(undefined)).toEqual(ignored);
    expect(toAxNode({ nodes: 'not-a-list' })).toEqual(ignored);
  });
});
