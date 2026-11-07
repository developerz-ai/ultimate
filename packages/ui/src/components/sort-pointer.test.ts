// The DOM half of a reorder, on hand-built nodes: groups read in DOCUMENT order whatever order
// their refs arrived in, a row's spans without the dragged one, focus handed back after a keyboard
// move, the page and the root as edge scrollers, the lifted row following the pointer, and
// `placeRows` moving only what is out of place. The fakes do only what each assertion reads.

import { afterEach, describe, expect, test } from 'bun:test';
import { fakeFrames, fakeMatchMedia, installGlobals } from '../browser-fake-fixture';
import { sortController } from '../drag/sort-controller';
import type { SortMove } from '../drag/sort-view';
import { FakeDocument, FakeElement } from '../fake-dom-fixture';
import { bindSortRow, placeRows, sortGeometry } from './sort-pointer';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const FOLLOWING = 4;

/** A node in one flat document: its `order` IS its document position. */
class FakeNode {
  static readonly DOCUMENT_POSITION_FOLLOWING = FOLLOWING;
  parent: FakeList | null = null;
  constructor(readonly name: string) {}
  remove(): void {
    const parent = this.parent;
    if (parent === null) return;
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1);
    this.parent = null;
  }
}

class FakeList extends FakeNode {
  readonly childNodes: FakeNode[] = [];
  inserts = 0;
  insertBefore(node: FakeNode, at: FakeNode | null): void {
    this.inserts += 1;
    node.remove();
    const index = at === null ? this.childNodes.length : this.childNodes.indexOf(at);
    this.childNodes.splice(index, 0, node);
    node.parent = this;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes.at(-1) ?? null;
  }
}

const listOf = (...names: string[]): FakeList => {
  const list = new FakeList('list');
  for (const name of names) list.insertBefore(new FakeNode(name), null);
  list.inserts = 0;
  return list;
};
const names = (list: FakeList): string[] => list.childNodes.map((node) => node.name);

describe('placeRows', () => {
  test('the list holds exactly the rows, in order; one no longer listed is removed', () => {
    restore = installGlobals({ Node: FakeNode });
    const list = listOf('a', 'b', 'c');
    const [a, , c] = list.childNodes;
    placeRows(list as never, [c, a]);
    expect(names(list)).toEqual(['c', 'a']);
  });

  test('a row from another list is moved in, leaving that list', () => {
    restore = installGlobals({ Node: FakeNode });
    const from = listOf('x', 'y');
    const to = listOf('a');
    const [x] = from.childNodes;
    placeRows(to as never, [to.childNodes[0], x]);
    expect(names(to)).toEqual(['a', 'x']);
    expect(names(from)).toEqual(['y']);
  });

  test('rows already in place are not touched, and a non-node row is no row', () => {
    restore = installGlobals({ Node: FakeNode });
    const list = listOf('a', 'b');
    placeRows(list as never, [...list.childNodes]);
    expect(list.inserts).toBe(0);
    placeRows(list as never, ['a string', null]);
    expect(names(list)).toEqual([]);
  });
});

interface Rect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}
const rectOf = (r: Rect) => ({ ...r, bottom: r.top + r.height, right: r.left + r.width });

interface FakeBox {
  readonly order: number;
  isConnected: boolean;
  readonly children: FakeBox[];
  readonly styleMap: Map<string, string>;
}

/** A group or row element: a document position, a box, attributes, and children. */
const element = (order: number, rect: Rect, attrs: Record<string, string> = {}) => {
  const style = new Map<string, string>();
  return {
    order,
    isConnected: true,
    children: [] as FakeBox[],
    style: {
      setProperty: (name: string, value: string) => style.set(name, value),
      removeProperty: (name: string) => style.delete(name),
    },
    styleMap: style,
    getAttribute: (name: string): string | null => attrs[name] ?? null,
    // A lifted row's box moves with its own transform, as the browser's does.
    getBoundingClientRect: () =>
      rectOf({
        ...rect,
        left: rect.left + Number.parseFloat(style.get('--drag-x') ?? '0'),
        top: rect.top + Number.parseFloat(style.get('--drag-y') ?? '0'),
      }),
    compareDocumentPosition(other: { order: number }): number {
      return other.order > order ? FOLLOWING : 2;
    },
  };
};

describe('sortGeometry', () => {
  test('groups are measured in document order, not registration order; a detached one is gone', () => {
    restore = installGlobals({ Node: FakeNode });
    const g = sortGeometry();
    const second = element(2, { top: 0, left: 300, width: 200, height: 500 });
    const first = element(1, { top: 0, left: 0, width: 200, height: 400 });
    const gone = element(3, { top: 0, left: 600, width: 10, height: 10 });
    g.group('done', second as never);
    g.group('todo', first as never);
    g.group('gone', gone as never);
    gone.isConnected = false;
    expect(g.groupBoxes()).toEqual([
      { inline: { start: 0, size: 200 }, block: { start: 0, size: 400 } },
      { inline: { start: 300, size: 200 }, block: { start: 0, size: 500 } },
    ]);
    expect(g.lists().map(([id]) => id)).toEqual(['done', 'todo']);
  });

  test('itemSpans leaves the dragged row out, and a group past the end has none', () => {
    restore = installGlobals({ Node: FakeNode });
    const g = sortGeometry();
    const list = element(1, { top: 0, left: 0, width: 100, height: 120 });
    for (const [i, key] of ['a', 'b', 'c'].entries()) {
      list.children.push(
        element(10 + i, { top: i * 40, left: 0, width: 100, height: 40 }, { 'data-sort-key': key }),
      );
    }
    g.group('list', list as never);
    expect(g.itemSpans(0, 'b')).toEqual([
      { start: 0, size: 40 },
      { start: 80, size: 40 },
    ]);
    expect(g.itemSpans(1, 'b')).toEqual([]);
  });

  test('refocus focuses the handle a microtask later; rowOf answers the registered row', async () => {
    const g = sortGeometry();
    const handle = new FakeElement('button');
    const row = element(1, { top: 0, left: 0, width: 1, height: 1 });
    g.handle('a', handle as never);
    g.row('a', row as never);
    expect(g.rowOf('a')).toBe(row as never);
    expect(g.rowOf('b')).toBeUndefined();
    g.refocus('a');
    expect(handle.focusCount).toBe(0);
    await Promise.resolve();
    expect(handle.focusCount).toBe(1);
    g.refocus('unknown');
    await Promise.resolve();
  });

  test('the page is always a scroller, the root one too once it is set', () => {
    const scrolled: number[][] = [];
    restore = installGlobals({
      innerHeight: 600,
      innerWidth: 800,
      scrollBy: (x: number, y: number) => scrolled.push([x, y]),
    });
    const g = sortGeometry();
    const [page] = g.scrollers();
    expect(g.scrollers()).toHaveLength(1);
    expect(page?.getBoundingClientRect()).toEqual({ top: 0, bottom: 600, left: 0, right: 800 });
    page?.scrollBy(0, 12);
    expect(scrolled).toEqual([[0, 12]]);
    const root = element(0, { top: 0, left: 0, width: 1, height: 1 });
    g.root(root as never);
    expect(g.scrollers()[1]).toBe(root as never);
  });
});

describe('bindSortRow', () => {
  const plain = {
    createSignal<T>(value: T): [() => T, (next: T) => void] {
      let current = value;
      return [
        () => current,
        (next: T) => {
          current = next;
        },
      ];
    },
  };

  const setup = (withDom = true, capture = true) => {
    const frames = fakeFrames();
    const scrolled: number[][] = [];
    const doc = new FakeDocument();
    restore = installGlobals({
      Node: FakeNode,
      innerHeight: 600,
      innerWidth: 800,
      scrollBy: (x: number, y: number) => scrolled.push([x, y]),
      requestAnimationFrame: frames.request,
      cancelAnimationFrame: frames.cancel,
      matchMedia: fakeMatchMedia(new Map([['(prefers-reduced-motion: reduce)', false]])),
      window: new FakeDocument(),
      ...(withDom ? { document: doc } : {}),
    });
    const moves: SortMove[] = [];
    const controller = sortController(plain, {
      groups: () => [{ id: 'list', items: ['a', 'b', 'c'] }],
      itemKey: (item: string) => item,
      onMove: (move) => moves.push(move),
      dir: () => 'ltr',
      groupLabel: (id) => id,
      say: () => {},
    });
    const geometry = sortGeometry();
    const list = element(1, { top: 0, left: 0, width: 100, height: 600 });
    for (const [i, key] of ['a', 'b', 'c'].entries()) {
      const row = element(
        10 + i,
        { top: i * 40, left: 0, width: 100, height: 40 },
        {
          'data-sort-key': key,
        },
      );
      list.children.push(row);
      geometry.row(key, row as never);
    }
    geometry.group('list', list as never);
    const handle = new FakeElement('button');
    if (capture) Object.assign(handle, { setPointerCapture: () => {} });
    const cleanups: (() => void)[] = [];
    bindSortRow(
      { onCleanup: (fn) => cleanups.push(fn) },
      geometry,
      controller,
      'a',
      handle as never,
    );
    return {
      frames,
      scrolled,
      controller,
      geometry,
      handle,
      cleanups,
      moves,
      row: list.children[0],
    };
  };

  const pointer = (x: number, y: number) => ({
    clientX: x,
    clientY: y,
    button: 0,
    isPrimary: true,
    pointerId: 1,
    preventDefault: () => {},
  });

  test('the lifted row follows the pointer, the page scrolls at its edge, the drop asks onMove', async () => {
    const s = setup();
    s.handle.dispatch('pointerdown', pointer(5, 5));
    s.handle.dispatch('pointermove', pointer(5, 110));
    expect(s.controller.lifted()).toBe('a');
    expect(s.row?.styleMap.get('--drag-y')).toBe('105px');
    expect(s.row?.styleMap.get('--drag-x')).toBe('0px');
    s.handle.dispatch('pointermove', pointer(5, 590));
    expect(s.row?.styleMap.get('--drag-y')).toBe('585px');
    s.frames.run();
    expect(s.scrolled.length).toBe(1);
    expect(s.scrolled[0]?.[1]).toBeGreaterThan(0);
    s.handle.dispatch('pointermove', pointer(5, 110));
    s.handle.dispatch('pointerup', pointer(5, 110));
    expect(s.row?.styleMap.size).toBe(0);
    expect(s.frames.pending()).toBe(0);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(s.moves).toEqual([{ id: 'a', fromGroup: 'list', toGroup: 'list', toIndex: 2 }]);
  });

  test('a cancelled drag drops the offset and asks nothing; the cleanup unbinds the handle', async () => {
    const s = setup();
    s.handle.dispatch('pointerdown', pointer(5, 5));
    s.handle.dispatch('pointermove', pointer(5, 110));
    s.handle.dispatch('pointercancel', {});
    expect(s.row?.styleMap.size).toBe(0);
    expect(s.controller.lifted()).toBeNull();
    expect(s.cleanups).toHaveLength(1);
    for (const fn of s.cleanups) fn();
    expect([...s.handle.listeners.values()].every((set) => set.size === 0)).toBe(true);
    await Promise.resolve();
    expect(s.moves).toEqual([]);
  });

  test('with no document, or no pointer capture, the handle is registered and nothing is bound', () => {
    for (const [dom, capture] of [
      [false, true],
      [true, false],
    ] as const) {
      const s = setup(dom, capture);
      expect(s.cleanups).toHaveLength(0);
      expect(s.handle.listeners.size).toBe(0);
      s.geometry.refocus('a');
      restore?.();
      restore = undefined;
    }
  });
});
