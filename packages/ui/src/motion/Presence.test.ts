// Presence on the server path — the inert runtime, no DOM: present content renders inside its
// wrapper as plain markup, absent content renders nothing, and no effect (no animation) runs.

import { describe, expect, test } from 'bun:test';
import { byTag, renderNodes } from '@ultimat3/core/render-nodes';
import { Presence } from './Presence';

describe('<Presence> — inert server render', () => {
  test('present: the wrapper, carrying its phase, around the content', () => {
    const nodes = renderNodes(Presence, { when: true, class: 'card', children: 'hello' });
    const [div] = byTag(nodes, 'div');
    expect(div?.props['data-presence']).toBe('present');
    expect(div?.props['class']).toBe('card');
    expect(JSON.stringify(nodes)).toContain('hello');
  });

  test('a function child receives the shown value', () => {
    const nodes = renderNodes(Presence, {
      when: 'post-7',
      as: 'li',
      children: (id: string) => `card ${id}`,
    });
    expect(byTag(nodes, 'li').length).toBe(1);
    expect(JSON.stringify(nodes)).toContain('card post-7');
  });

  test('each `as` renders exactly that element', () => {
    for (const tag of ['div', 'li', 'section', 'span']) {
      expect(byTag(renderNodes(Presence, { when: 1, as: tag, children: 'x' }), tag).length).toBe(1);
    }
  });

  test('absent (false, null, undefined): nothing at all', () => {
    for (const when of [false, null, undefined]) {
      expect(byTag(renderNodes(Presence, { when, children: 'x' }), 'div')).toEqual([]);
    }
  });
});
