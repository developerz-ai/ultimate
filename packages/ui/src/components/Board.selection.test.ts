// Card selection on a board, the same rules as a table's rows: a native box per card in one form
// with scripting off, Shift+click and the keys ranging in reading order across columns, and a
// finger held on a card's body ticking its box. The bar sits under the board, never in its grid.

import '../theme/ambient';
import { afterEach, describe, expect, jest, test } from 'bun:test';
import {
  attachRef,
  byTag,
  fire,
  nodesOf,
  type RenderNode,
  renderNodes,
} from '@ultimat3/core/render-nodes';
import { Board } from './Board';
import { NO_SELECTION, type RowSelection } from './row-selection';

const COLUMNS = [
  { id: 'draft', label: 'Draft', items: ['p1', 'p2'] },
  { id: 'scheduled', label: 'Scheduled', items: [] },
  { id: 'published', label: 'Published', items: ['p3'] },
];

const board = (selection: Record<string, unknown>): RenderNode[] =>
  renderNodes(Board, {
    groups: COLUMNS,
    itemKey: (item: string) => item,
    renderItem: (item: string) => item,
    label: 'Posts',
    onMove: () => undefined,
    selection: {
      name: 'ids',
      form: 'bulk',
      label: (item: string) => `Select ${item}`,
      value: NO_SELECTION,
      ...selection,
    },
  });

const boxFor = (nodes: readonly RenderNode[], key: string): RenderNode => {
  const found = byTag(nodes, 'input').find((node) => node.props['data-select-key'] === key);
  if (found === undefined) return expect.unreachable(`no box for ${key}`);
  return found;
};

/** The body `<div>` of a card: the element whose ref binds the long press. */
const bodyOf = (nodes: readonly RenderNode[], key: string): RenderNode => {
  const body = byTag(nodes, 'div').find(
    (node) => node.props['ref'] !== undefined && node.props['children'] === key,
  );
  if (body === undefined) return expect.unreachable(`no body for ${key}`);
  return body;
};

describe('Board selection with scripting off', () => {
  test('a native box per card posting its key, in one form', () => {
    const nodes = board({ value: { kind: 'keys', keys: ['p3'] } });
    expect(
      ['p1', 'p2', 'p3'].map((key) => {
        const box = boxFor(nodes, key);
        return [box.props['name'], box.props['value'], box.props['form'], box.props['checked']];
      }),
    ).toEqual([
      ['ids', 'p1', 'bulk', false],
      ['ids', 'p2', 'bulk', false],
      ['ids', 'p3', 'bulk', true],
    ]);
  });

  test('the bar is a sibling of the board, not a column in its grid', () => {
    const nodes = board({});
    const status = byTag(nodes, 'p').filter((node) => node.props['role'] === 'status');
    expect(status).toHaveLength(1);
    const scope = nodes.find((node) => node.props['data-selection-scope'] === '');
    if (scope === undefined) return expect.unreachable('no selection scope');
    const inside = nodesOf(scope.props['children']);
    expect(inside.filter((node) => node.props['data-select-key'] !== undefined)).toHaveLength(3);
    expect(inside.some((node) => node.props['role'] === 'status')).toBe(false);
  });
});

describe('Board selection with a callback', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('Shift+click ranges in reading order, across columns', () => {
    const seen: RowSelection[] = [];
    const nodes = board({ onChange: (next: RowSelection) => seen.push(next) });
    fire(boxFor(nodes, 'p2'), 'onClick', { shiftKey: false });
    fire(boxFor(nodes, 'p3'), 'onClick', { shiftKey: true });
    expect(seen).toEqual([
      { kind: 'keys', keys: ['p2'] },
      { kind: 'keys', keys: ['p2', 'p3'] },
    ]);
  });

  test('a finger held on a card’s body ticks it; a mouse press does not', () => {
    jest.useFakeTimers();
    const seen: RowSelection[] = [];
    const nodes = board({ onChange: (next: RowSelection) => seen.push(next) });
    const listeners = new Map<string, (event: unknown) => void>();
    attachRef(bodyOf(nodes, 'p1'), {
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    });
    const down = (pointerType: string): void =>
      listeners.get('pointerdown')?.({ pointerType, clientX: 5, clientY: 5 });

    down('mouse');
    jest.advanceTimersByTime(1_000);
    expect(seen).toEqual([]);

    down('touch');
    jest.advanceTimersByTime(1_000);
    expect(seen).toEqual([{ kind: 'keys', keys: ['p1'] }]);

    // The lift's click would tick the box a second time: it is swallowed.
    let stopped = false;
    listeners.get('click')?.({
      preventDefault: () => {},
      stopPropagation: () => {
        stopped = true;
      },
    });
    expect(stopped).toBe(true);
  });

  test('without a callback no long press is bound', () => {
    const nodes = board({});
    let bound = 0;
    attachRef(bodyOf(nodes, 'p1'), {
      addEventListener: () => {
        bound += 1;
      },
    });
    expect(bound).toBe(0);
  });
});
