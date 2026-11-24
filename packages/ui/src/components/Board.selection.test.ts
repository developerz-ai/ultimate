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
import { syncRuntime } from '../browser-fake-fixture';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import { Board } from './Board';
import { NO_SELECTION, type RowSelection } from './row-selection';

const COLUMNS = [
  { id: 'draft', label: 'Draft', items: ['p1', 'p2'] },
  { id: 'scheduled', label: 'Scheduled', items: [] },
  { id: 'published', label: 'Published', items: ['p3'] },
];

const board = (
  selection: Record<string, unknown>,
  groups: () => typeof COLUMNS = () => COLUMNS,
): RenderNode[] =>
  renderNodes(Board, {
    get groups() {
      return groups();
    },
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
  const found = byTag(nodes, 'input').find(
    (node) => node.props['name'] === 'ids' && node.props['value'] === key,
  );
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

  test('the bar is a sibling of the board, not a column in its grid (its count, with a callback)', () => {
    const nodes = board({ onChange: () => {} });
    const status = byTag(nodes, 'p').filter((node) => node.props['role'] === 'status');
    expect(status).toHaveLength(1);
    const surface = nodes.find((node) => node.props['aria-label'] === 'Posts');
    if (surface === undefined) return expect.unreachable('no board');
    const inside = nodesOf(surface.props['children']);
    expect(inside.filter((node) => node.props['name'] === 'ids')).toHaveLength(3);
    expect(inside.some((node) => node.props['role'] === 'status')).toBe(false);
  });
});

describe('Board selection with a callback', () => {
  afterEach(() => {
    jest.useRealTimers();
    clearSolidRuntime();
  });

  test('Shift+click ranges in reading order, across columns', () => {
    const seen: RowSelection[] = [];
    const nodes = board({ onChange: (next: RowSelection) => seen.push(next) });
    fire(boxFor(nodes, 'p2'), 'onClick', { shiftKey: false, currentTarget: {} });
    fire(boxFor(nodes, 'p3'), 'onClick', { shiftKey: true, currentTarget: {} });
    expect(seen).toEqual([
      { kind: 'keys', keys: ['p2'] },
      { kind: 'keys', keys: ['p2', 'p3'] },
    ]);
  });

  test('ArrowDown moves focus in reading order, across columns', () => {
    const nodes = board({ onChange: () => {} });
    let focused: string | undefined;
    for (const key of ['p1', 'p2', 'p3']) {
      attachRef(boxFor(nodes, key), {
        focus: () => {
          focused = key;
        },
      });
    }
    const down = { key: 'ArrowDown', shiftKey: false, ctrlKey: false, metaKey: false };
    fire(boxFor(nodes, 'p2'), 'onKeyDown', { ...down, altKey: false, preventDefault: () => {} });
    // Past the empty "scheduled" column to the first card of "published".
    expect(focused).toBe('p3');
  });

  test('a move preview in flight is the order a Shift range follows', () => {
    const seen: RowSelection[] = [];
    const nodes = board({ onChange: (next: RowSelection) => seen.push(next) });
    const handle = byTag(nodes, 'button').find((node) => node.props['data-sort-handle'] === 'p1');
    if (handle === undefined) return expect.unreachable('no handle for p1');
    const press = (key: string) => ({ key, altKey: false, preventDefault: () => {} });
    // Lift p1 and carry it below p2: the board shows p2, p1, p3.
    fire(handle, 'onKeyDown', press(' '));
    fire(handle, 'onKeyDown', press('ArrowDown'));
    fire(boxFor(nodes, 'p1'), 'onClick', { shiftKey: false, currentTarget: {} });
    fire(boxFor(nodes, 'p3'), 'onClick', { shiftKey: true, currentTarget: {} });
    expect(seen.at(-1)).toEqual({ kind: 'keys', keys: ['p1', 'p3'] });
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

    // The lift's click would tick the box a second time, or follow a link in the card: it is
    // cancelled, and only it — a keyboard activation after it is the reader's own.
    const click = (detail: number) => {
      const seenBy = { prevented: false, stopped: false };
      listeners.get('click')?.({
        detail,
        preventDefault: () => {
          seenBy.prevented = true;
        },
        stopPropagation: () => {
          seenBy.stopped = true;
        },
      });
      return seenBy;
    };
    expect(click(1)).toEqual({ prevented: true, stopped: true });
    expect(click(0)).toEqual({ prevented: false, stopped: false });
  });

  test('a keyboard click after a long press with no lift click is not swallowed', () => {
    jest.useFakeTimers();
    const nodes = board({ onChange: () => {} });
    const listeners = new Map<string, (event: unknown) => void>();
    attachRef(bodyOf(nodes, 'p1'), {
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    });
    listeners.get('pointerdown')?.({ pointerType: 'touch', clientX: 5, clientY: 5 });
    jest.advanceTimersByTime(1_000);
    let prevented = false;
    listeners.get('click')?.({
      detail: 0,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {},
    });
    expect(prevented).toBe(false);
  });

  test('a touch the browser cancels before the delay ticks nothing', () => {
    jest.useFakeTimers();
    const seen: RowSelection[] = [];
    const nodes = board({ onChange: (next: RowSelection) => seen.push(next) });
    const listeners = new Map<string, (event: unknown) => void>();
    attachRef(bodyOf(nodes, 'p1'), {
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    });
    listeners.get('pointerdown')?.({ pointerType: 'touch', clientX: 5, clientY: 5 });
    listeners.get('pointercancel')?.({});
    jest.advanceTimersByTime(1_000);
    expect(seen).toEqual([]);
  });

  test('a card that left the board before the press fired ticks nothing', () => {
    jest.useFakeTimers();
    const seen: RowSelection[] = [];
    let groups = COLUMNS;
    const nodes = board({ onChange: (next: RowSelection) => seen.push(next) }, () => groups);
    const listeners = new Map<string, (event: unknown) => void>();
    attachRef(bodyOf(nodes, 'p1'), {
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    });
    listeners.get('pointerdown')?.({ pointerType: 'touch', clientX: 5, clientY: 5 });
    groups = COLUMNS.map((column) => ({
      ...column,
      items: column.items.filter((item) => item !== 'p1'),
    }));
    jest.advanceTimersByTime(1_000);
    expect(seen).toEqual([]);
  });

  test('a card disposed with a finger still down cancels its pending press', () => {
    jest.useFakeTimers();
    const sync = syncRuntime();
    setSolidRuntime(sync.runtime);
    const seen: RowSelection[] = [];
    const nodes = board({ onChange: (next: RowSelection) => seen.push(next) });
    const listeners = new Map<string, (event: unknown) => void>();
    attachRef(bodyOf(nodes, 'p1'), {
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    });
    listeners.get('pointerdown')?.({ pointerType: 'touch', clientX: 5, clientY: 5 });
    sync.unmount();
    jest.advanceTimersByTime(1_000);
    expect(seen).toEqual([]);
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
