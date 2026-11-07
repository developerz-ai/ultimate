// The WIRING of the reorder and split components, read off the elements they render: the handle's
// key handler reaches `onMove` once, Esc reaches nothing, the no-script form posts the fields the
// caller named, and the separator answers its keys. The rules themselves are in `drag/`.

import '../theme/ambient';
import { describe, expect, test } from 'bun:test';
import {
  byTag,
  fire,
  one,
  type RenderNode,
  renderNodes,
  withAttr,
} from '@ultimat3/core/render-nodes';
import { keydown } from '../fake-dom-fixture';
import { Board } from './Board';
import { SortableList } from './SortableList';
import { SplitPane } from './SplitPane';

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

const handleOf = (nodes: readonly RenderNode[], id: string): RenderNode =>
  one(withAttr(nodes, 'data-sort-handle', id), `handle ${id}`);

const listProps = (onMove: (move: unknown) => unknown, extra: Record<string, unknown> = {}) => ({
  items: ['a', 'b', 'c'],
  itemKey: (item: string) => item,
  renderItem: (item: string) => item,
  label: 'Priorities',
  onMove,
  ...extra,
});

describe('SortableList', () => {
  test('lift, move and drop by keyboard call onMove once, with the final index', async () => {
    const moves: unknown[] = [];
    const nodes = renderNodes(
      SortableList,
      listProps((move) => moves.push(move)),
    );
    const handle = handleOf(nodes, 'a');
    for (const key of [' ', 'ArrowDown', ' ']) fire(handle, 'onKeyDown', keydown(key));
    await settle();
    expect(moves).toEqual([{ id: 'a', fromGroup: 'list', toGroup: 'list', toIndex: 1 }]);
  });

  test('Escape after a lift and a move calls nothing', async () => {
    const moves: unknown[] = [];
    const nodes = renderNodes(
      SortableList,
      listProps((move) => moves.push(move)),
    );
    const handle = handleOf(nodes, 'b');
    for (const key of [' ', 'ArrowUp', 'Escape']) fire(handle, 'onKeyDown', keydown(key));
    await settle();
    expect(moves).toEqual([]);
  });

  test('the handle is a named button that cannot scroll the page, and a body key is left alone', () => {
    const nodes = renderNodes(
      SortableList,
      listProps(() => undefined),
    );
    const handle = handleOf(nodes, 'a');
    expect(handle.type).toBe('button');
    expect(handle.props['type']).toBe('button');
    expect(String(handle.props['aria-label'])).not.toBe('');
    const event = keydown('Tab');
    fire(handle, 'onKeyDown', event);
    expect(event.defaultPrevented).toBe(false);
  });

  test('with an action, every row carries Up and Down as real submits with the caller field names', () => {
    const nodes = renderNodes(
      SortableList,
      listProps(() => undefined, {
        action: '/api/tasks/move',
        fields: { toIndex: 'position', fromGroup: null },
      }),
    );
    const forms = byTag(nodes, 'form');
    expect(forms).toHaveLength(3);
    expect(forms[0]?.props['method']).toBe('post');
    expect(forms[0]?.props['action']).toBe('/api/tasks/move');
    const submits = byTag(nodes, 'button').filter((node) => node.props['type'] === 'submit');
    expect(submits.map((node) => [node.props['name'], node.props['value']])).toEqual([
      ['position', '-1'],
      ['position', '1'],
      ['position', '0'],
      ['position', '2'],
      ['position', '1'],
      ['position', '3'],
    ]);
    // The first row cannot go up, the last cannot go down.
    expect(submits[0]?.props['disabled']).toBe(true);
    expect(submits[5]?.props['disabled']).toBe(true);
    const hidden = byTag(nodes, 'input').map((node) => node.props['name']);
    expect(hidden).not.toContain('fromGroup');
    expect(hidden).toContain('id');
  });

  test('two rows under one key are X_UI_INVALID_VALUE', () => {
    expect(() =>
      renderNodes(
        SortableList,
        listProps(() => undefined, { items: ['a', 'a'] }),
      ),
    ).toThrow(/itemKey/);
  });
});

describe('Board', () => {
  const columns = [
    { id: 'draft', label: 'Draft', items: ['p1', 'p2'] },
    { id: 'scheduled', label: 'Scheduled', items: [] },
    { id: 'published', label: 'Published', items: ['p3'] },
  ];

  test('ArrowRight carries a card to the next column; canDrop skips a refused one', async () => {
    const moves: unknown[] = [];
    const nodes = renderNodes(Board, {
      groups: columns,
      itemKey: (item: string) => item,
      renderItem: (item: string) => item,
      label: 'Posts',
      onMove: (move: unknown) => moves.push(move),
      canDrop: (_item: string, group: string) => group !== 'scheduled',
    });
    expect(withAttr(nodes, 'role', 'group').length).toBeGreaterThanOrEqual(3);
    const handle = handleOf(nodes, 'p2');
    for (const key of [' ', 'ArrowRight', ' ']) fire(handle, 'onKeyDown', keydown(key));
    await settle();
    expect(moves).toEqual([{ id: 'p2', fromGroup: 'draft', toGroup: 'published', toIndex: 1 }]);
  });

  test('with scripting off each card posts a target column, refused columns left out', () => {
    const nodes = renderNodes(Board, {
      groups: columns,
      itemKey: (item: string) => item,
      renderItem: (item: string) => item,
      label: 'Posts',
      onMove: () => undefined,
      canDrop: (_item: string, group: string) => group !== 'published',
      action: '/api/posts/move',
      fields: { fromGroup: 'from', toGroup: 'to', toIndex: null },
    });
    const selects = byTag(nodes, 'select');
    expect(selects).toHaveLength(3);
    expect(selects[0]?.props['name']).toBe('to');
    const firstOptions = byTag(nodes, 'option')
      .slice(0, 2)
      .map((node) => node.props['value']);
    expect(firstOptions).toEqual(['draft', 'scheduled']);
  });

  test('a column id twice is refused', () => {
    expect(() =>
      renderNodes(Board, {
        groups: [columns[0], columns[0]],
        itemKey: (item: string) => item,
        renderItem: (item: string) => item,
        label: 'Posts',
        onMove: () => undefined,
      }),
    ).toThrow(/column id/);
  });
});

describe('SplitPane', () => {
  const separatorOf = (nodes: readonly RenderNode[]): RenderNode =>
    one(withAttr(nodes, 'role', 'separator'), 'separator');

  test('the separator carries its value and bounds, and arrows step it by 5', () => {
    const sizes: number[] = [];
    const nodes = renderNodes(SplitPane, {
      start: 'log',
      end: 'detail',
      defaultValue: 40,
      min: 20,
      max: 80,
      onResize: (percent: number) => sizes.push(percent),
    });
    const separator = separatorOf(nodes);
    expect(separator.props['aria-valuenow']).toBe(40);
    expect(separator.props['aria-valuemin']).toBe(20);
    expect(separator.props['tabindex']).toBe('0');
    fire(separator, 'onKeyDown', keydown('ArrowRight'));
    fire(separator, 'onKeyDown', keydown('End'));
    expect(sizes).toEqual([45, 80]);
  });

  test('a defaultValue outside min and max is X_UI_INVALID_VALUE', () => {
    expect(() =>
      renderNodes(SplitPane, { start: 'a', end: 'b', defaultValue: 90, max: 80 }),
    ).toThrow(/SplitPane/);
  });
});
