// PresenceList on the server path: every item in its own wrapper, in order, inside the list
// element asked for — plain markup, nothing animated.

import { describe, expect, test } from 'bun:test';
import { byTag, renderNodes } from '@ultimat3/core/render-nodes';
import { PresenceList } from './PresenceList';

const each = [{ id: 'a' }, { id: 'b' }];
const children = (item: () => { id: string }, key: string) => `${key}:${item().id}`;

describe('<PresenceList> — inert server render', () => {
  test('a ul of li, one per item, in order', () => {
    const nodes = renderNodes(PresenceList, { each, key: (i: { id: string }) => i.id, children });
    expect(byTag(nodes, 'ul').length).toBe(1);
    expect(byTag(nodes, 'li').length).toBe(2);
    const text = JSON.stringify(nodes);
    expect(text.indexOf('a:a')).toBeLessThan(text.indexOf('b:b'));
  });

  test('as="ol" and as="div" render that list element', () => {
    const key = (i: { id: string }) => i.id;
    expect(byTag(renderNodes(PresenceList, { each, key, children, as: 'ol' }), 'ol').length).toBe(
      1,
    );
    const div = renderNodes(PresenceList, { each, key, children, as: 'div' });
    expect(byTag(div, 'div').length).toBe(3);
    expect(byTag(div, 'li')).toEqual([]);
  });
});
