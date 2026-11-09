// The shared reorder machine, with a plain-signal runtime: keyboard lift, move and drop call
// `onMove` once with the right index; Esc calls nothing; each step is said; a refused move puts the
// row back and says so; a pointer drag lands where the measured rows put it.

import { describe, expect, test } from 'bun:test';
import type { Accessor, Setter } from '../theme/solid-adapter';
import { type SortControllerInput, type SortMeasure, sortController } from './sort-controller';
import type { SortGroup, SortMove } from './sort-view';

const plain = {
  createSignal<T>(value: T): [Accessor<T>, Setter<T>] {
    let current = value;
    const set = (next: T): void => {
      current = next;
    };
    return [() => current, set];
  },
};

const key = (k: string) => ({ key: k, altKey: false });
/** Drains the microtask queue far enough for `onMove`'s answer to land: no clock involved. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

function harness(
  groups: readonly SortGroup<string>[],
  onMove: (move: SortMove) => unknown = () => undefined,
  extra: Partial<SortControllerInput<string>> = {},
) {
  const said: string[] = [];
  const moves: SortMove[] = [];
  const controller = sortController(plain, {
    groups: () => groups,
    itemKey: (item) => item,
    onMove: (move) => {
      moves.push(move);
      return onMove(move);
    },
    dir: () => 'ltr',
    groupLabel: (id) => id,
    say: (what, p) => said.push(`${what} ${p.position}/${p.total} ${p.group}`),
    ...extra,
  });
  const order = (): string[][] => controller.view().map((group) => [...group.items]);
  return { controller, said, moves, order };
}

const list = [{ id: 'list', items: ['a', 'b', 'c'] }];

describe('keyboard', () => {
  test('Space lifts, ArrowDown moves, Space drops: one onMove with the final index', async () => {
    const h = harness(list);
    expect(h.controller.key('a', key(' '))).toBe(true);
    h.controller.key('a', key('ArrowDown'));
    h.controller.key('a', key('ArrowDown'));
    expect(h.order()).toEqual([['b', 'c', 'a']]);
    h.controller.key('a', key(' '));
    await settle();
    expect(h.moves).toEqual([{ id: 'a', fromGroup: 'list', toGroup: 'list', toIndex: 2 }]);
    expect(h.said).toEqual([
      'lift 1/3 list',
      'moved 2/3 list',
      'moved 3/3 list',
      'dropped 3/3 list',
    ]);
  });

  test('Escape calls nothing and restores the order', () => {
    const h = harness(list);
    h.controller.key('b', key(' '));
    h.controller.key('b', key('ArrowUp'));
    h.controller.key('b', key('Escape'));
    expect(h.moves).toEqual([]);
    expect(h.order()).toEqual([['a', 'b', 'c']]);
    expect(h.said.at(-1)).toBe('cancelled 2/3 list');
    expect(h.controller.lifted()).toBeNull();
  });

  test('a rejected move puts the row back and says so', async () => {
    const h = harness(list, () => Promise.reject(new Error('X_STATE_CONFLICT')));
    h.controller.key('a', key(' '));
    h.controller.key('a', key('ArrowDown'));
    h.controller.key('a', key(' '));
    // Held at its drop while the request is in flight: no jump before the answer.
    expect(h.order()).toEqual([['b', 'a', 'c']]);
    await settle();
    expect(h.order()).toEqual([['a', 'b', 'c']]);
    expect(h.said.at(-1)).toBe('cancelled 1/3 list');
  });

  test('Alt+Arrow on a resting handle is a direct move', async () => {
    const h = harness(list);
    expect(h.controller.key('b', { key: 'ArrowUp', altKey: true })).toBe(true);
    await settle();
    expect(h.moves).toEqual([{ id: 'b', fromGroup: 'list', toGroup: 'list', toIndex: 0 }]);
  });

  test('two Alt+Arrows before the echo step from the held move, and the hold outlives the first answer', async () => {
    const answers: Array<() => void> = [];
    const h = harness(
      [{ id: 'list', items: ['a', 'b', 'c', 'd'] }],
      () => new Promise<void>((resolve) => answers.push(resolve)),
    );
    const down = { key: 'ArrowDown', altKey: true };
    h.controller.key('a', down);
    h.controller.key('a', down);
    await settle();
    expect(h.moves.map((move) => move.toIndex)).toEqual([1, 2]);
    expect(h.order()).toEqual([['b', 'c', 'a', 'd']]);
    answers[0]?.();
    await settle();
    expect(h.order()).toEqual([['b', 'c', 'a', 'd']]);
    answers[1]?.();
    await settle();
    expect(h.order()).toEqual([['a', 'b', 'c', 'd']]);
  });

  test('across a board, canDrop false keeps the card out of a column', async () => {
    const board = [
      { id: 'draft', items: ['a'] },
      { id: 'published', items: [] },
      { id: 'scheduled', items: [] },
    ];
    const h = harness(board, undefined, { canDrop: (_item, group) => group !== 'published' });
    h.controller.key('a', key(' '));
    h.controller.key('a', key('ArrowRight'));
    h.controller.key('a', key(' '));
    await settle();
    expect(h.moves).toEqual([{ id: 'a', fromGroup: 'draft', toGroup: 'scheduled', toIndex: 0 }]);
  });

  test('a drop back where it started requests nothing', async () => {
    const h = harness(list);
    h.controller.key('a', key(' '));
    h.controller.key('a', key(' '));
    await settle();
    expect(h.moves).toEqual([]);
  });
});

describe('pointer', () => {
  test('the measured rows decide the index; the drop requests it once', async () => {
    const h = harness(list);
    // Rows 40 px tall at 0, 40, 80; `without` drops the dragged one, as the DOM read does.
    const measure: SortMeasure = {
      groupBoxes: () => [{ inline: { start: 0, size: 300 }, block: { start: 0, size: 120 } }],
      itemSpans: (_g, without) =>
        h
          .order()[0]
          ?.filter((item) => item !== without)
          .map((_item, i) => ({ start: i * 40, size: 40 })) ?? [],
    };
    const drag = h.controller.pointer('a', measure);
    drag.start({ x: 10, y: 10 });
    drag.move({ x: 10, y: 70 });
    expect(h.order()).toEqual([['b', 'c', 'a']]);
    drag.drop({ x: 10, y: 70 });
    await settle();
    expect(h.moves).toEqual([{ id: 'a', fromGroup: 'list', toGroup: 'list', toIndex: 2 }]);
  });

  test('a cancelled drag restores and calls nothing', () => {
    const h = harness(list);
    const drag = h.controller.pointer('a', {
      groupBoxes: () => [],
      itemSpans: () => [
        { start: 0, size: 40 },
        { start: 40, size: 40 },
      ],
    });
    drag.start({ x: 0, y: 0 });
    drag.move({ x: 0, y: 90 });
    drag.cancel();
    expect(h.moves).toEqual([]);
    expect(h.order()).toEqual([['a', 'b', 'c']]);
  });
});
