// The DOM half of a reorder: where each group and row is, the pointer gesture bound to a handle,
// the lifted row following the pointer (input, not animation, so reduced motion keeps it), the
// edge scroll, and focus handed back to a handle a keyboard move re-parented.

import {
  autoScroller,
  bindPointerDrag,
  browserScrollEnv,
  type Scrollable,
} from '../drag/pointer-drag';
import type { SortController, SortMeasure } from '../drag/sort-controller';
import type { AxisSpan } from '../drag/sort-view';

export interface SortGeometry extends SortMeasure {
  root(el: HTMLElement): void;
  group(id: string, el: HTMLElement): void;
  row(id: string, el: HTMLElement): void;
  rowOf(id: string): HTMLElement | undefined;
  /** Every list in the document now, by group id. */
  lists(): readonly (readonly [string, HTMLElement])[];
  handle(id: string, el: HTMLElement): void;
  refocus(id: string): void;
  scrollers(): readonly Scrollable[];
}

const inline = (el: Element): AxisSpan => {
  const rect = el.getBoundingClientRect();
  return { start: rect.left, size: rect.width };
};
const block = (el: Element): AxisSpan => {
  const rect = el.getBoundingClientRect();
  return { start: rect.top, size: rect.height };
};

/** Registries filled by refs. Groups are read in document order, so a re-render cannot reorder them. */
export function sortGeometry(): SortGeometry {
  let root: HTMLElement | undefined;
  const groups = new Map<string, HTMLElement>();
  const rows = new Map<string, HTMLElement>();
  const handles = new Map<string, HTMLElement>();
  const live = (): HTMLElement[] =>
    [...groups.values()]
      .filter((el) => el.isConnected)
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return {
    root: (el) => {
      root = el;
    },
    group: (id, el) => groups.set(id, el),
    row: (id, el) => rows.set(id, el),
    rowOf: (id) => rows.get(id),
    lists: () => [...groups].filter(([, el]) => el.isConnected),
    handle: (id, el) => handles.set(id, el),
    groupBoxes: () => live().map((el) => ({ inline: inline(el), block: block(el) })),
    itemSpans: (g, without) => {
      const list = live()[g];
      if (list === undefined) return [];
      return [...list.children]
        .filter((child) => child.getAttribute('data-sort-key') !== without)
        .map(block);
    },
    // A keyboard move re-parents the focused row, and the browser drops focus to <body> with it.
    refocus: (id) => queueMicrotask(() => handles.get(id)?.focus()),
    scrollers: () => {
      const page: Scrollable = {
        getBoundingClientRect: () => ({ top: 0, bottom: innerHeight, left: 0, right: innerWidth }),
        scrollBy: (x, y) => scrollBy(x, y),
      };
      return root === undefined ? [page] : [page, root];
    },
  };
}

/** Binds one handle; the binding is undone when the row's owner is disposed. */
export function bindSortRow<T>(
  rt: { onCleanup(fn: () => void): void },
  geometry: SortGeometry,
  controller: SortController<T>,
  id: string,
  handle: HTMLElement,
): void {
  geometry.handle(id, handle);
  if (typeof document === 'undefined' || typeof handle.setPointerCapture !== 'function') return;
  const sort = controller.pointer(id, geometry);
  let grab = { x: 0, y: 0 };
  let shift = { x: 0, y: 0 };
  let scroll: { update(p: { x: number; y: number }): void; stop(): void }[] = [];
  const place = (row: HTMLElement | undefined, x: number, y: number): void => {
    if (row === undefined) return;
    const rect = row.getBoundingClientRect();
    shift = { x: x - grab.x - (rect.left - shift.x), y: y - grab.y - (rect.top - shift.y) };
    row.style.setProperty('--drag-x', `${shift.x}px`);
    row.style.setProperty('--drag-y', `${shift.y}px`);
  };
  const settle = (): void => {
    for (const scroller of scroll) scroller.stop();
    scroll = [];
    const row = geometry.rowOf(id);
    row?.style.removeProperty('--drag-x');
    row?.style.removeProperty('--drag-y');
    shift = { x: 0, y: 0 };
  };
  const unbind = bindPointerDrag(handle, {
    start: (origin) => {
      const rect = geometry.rowOf(id)?.getBoundingClientRect();
      grab = rect === undefined ? origin : { x: origin.x - rect.left, y: origin.y - rect.top };
      const env = browserScrollEnv();
      scroll = geometry.scrollers().map((box) => autoScroller(env, box));
      sort.start(origin);
    },
    move: (point) => {
      sort.move(point);
      place(geometry.rowOf(id), point.x, point.y);
      for (const scroller of scroll) scroller.update(point);
    },
    drop: (point) => {
      settle();
      sort.drop(point);
    },
    cancel: () => {
      settle();
      sort.cancel();
    },
  });
  rt.onCleanup(unbind);
}

/**
 * `list` holds exactly `rows`, in order, moving nodes that are elsewhere and dropping its own that
 * are no longer listed. Only ever `insertBefore` and a removal of a child this list still holds.
 */
export function placeRows(list: HTMLElement, rows: readonly unknown[]): void {
  const nodes = rows.filter(
    (row): row is Node => typeof Node !== 'undefined' && row instanceof Node,
  );
  nodes.forEach((node, index) => {
    const at = list.childNodes[index] ?? null;
    if (at !== node) list.insertBefore(node, at);
  });
  while (list.childNodes.length > nodes.length) list.lastChild?.remove();
}
