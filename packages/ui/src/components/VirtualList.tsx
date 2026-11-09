// A long list that mounts only what is on screen: a real `<ul>` in a scroll box, padded above and
// below by what is not drawn. Server-rendered, and with scripting off, every row renders — the
// document carries the whole list. The arithmetic is `virtual-list-view.ts`; this file is wiring.

import { finiteCount, finiteOption } from '@ultimat3/core';
import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { invalidValueError } from '../errors';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import type { Accessor } from '../theme/solid-adapter';
import { solid } from '../theme/solid-adapter';
import { keyedRows } from './data-table-rows';
import styles from './VirtualList.module.scss';
import { domRowOffset, readDomAnchor } from './virtual-list-anchor';
import { createVirtualListObserver, type VirtualListObserver } from './virtual-list-observer';
import {
  anchorAt,
  anchorCorrection,
  anchoredScrollTop,
  assertUniqueKeys,
  endDistance,
  nextAtEnd,
  pruneHeights,
  rowOffsets,
  type ScrollAnchor,
  VIRTUAL_LIST_ESTIMATE,
  VIRTUAL_LIST_OVERSCAN,
  visibleRange,
} from './virtual-list-view';

export interface VirtualListProps<T> {
  items: readonly T[];
  /** Unique per item: a visible row keeps its node — and its focus — across a live prepend. */
  itemKey: (item: T) => string;
  renderItem: (item: T) => JSX.Element;
  /** A row's block size in CSS px until it is measured. A right estimate IS fixed-height mode. */
  estimate?: number | undefined;
  /** Rows drawn beyond each edge of the box. */
  overscan?: number | undefined;
  /** Stay at the end as items arrive, while the reader is there; offer a way back when not. */
  follow?: boolean | undefined;
  /** Already-translated accessible name for the list. */
  label: string;
  /** Size the box here: the list scrolls inside the caller's height, and a box with none renders every row. */
  class?: string | undefined;
}

const px = (value: number): string => `${String(Math.max(0, Math.round(value)))}px`;

/** No smooth scroll by default, and none at all for a reader who asked the platform for less motion. */
const scrollBehavior = (): ScrollBehavior =>
  typeof matchMedia === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'smooth'
    : 'auto';

export function VirtualList<T>(props: VirtualListProps<T>): JSX.Element {
  const rt = solid();
  const ui = useUi();
  const estimate = (): number => {
    const value = finiteOption('VirtualList', 'estimate', props.estimate ?? VIRTUAL_LIST_ESTIMATE);
    if (value <= 0) throw invalidValueError('VirtualList estimate', value, 'a block size above 0');
    return value;
  };
  const overscan = (): number =>
    finiteCount('VirtualList', 'overscan', props.overscan ?? VIRTUAL_LIST_OVERSCAN, 0);

  const heights = new Map<string, number>();
  const [measured, setMeasured] = rt.createSignal(0);
  // `undefined` is a server render, which draws every row. In a browser the window stands in for
  // the box until the box has been measured, so the first paint is a screenful, not the list.
  const [viewport, setViewport] = rt.createSignal<number | undefined>(
    typeof window === 'undefined' ? undefined : window.innerHeight,
  );
  const [scrollTop, setScrollTop] = rt.createSignal(0);
  const [behind, setBehind] = rt.createSignal(false);
  let box: HTMLDivElement | undefined;
  let observer: VirtualListObserver | undefined;
  const mounted = new Set<HTMLElement>();
  let atEnd = true;
  let anchor: ScrollAnchor | undefined;

  interface Layout {
    readonly keys: readonly string[];
    readonly positions: ReadonlyMap<string, number>;
    readonly offsets: readonly number[];
  }
  /** The layout the DOM is drawn from right now: the one a new layout's anchor is read against. */
  let shown: Layout | undefined;

  /**
   * Where the reader is, read off the DOM before it changes. Called as a new layout is computed,
   * so a scroll whose event has not fired yet — a `focus()` that scrolled a row into view, a fling
   * in the same frame as a live update — is still where the anchor is taken. The DOM, not the
   * layout: a row drawn but not yet measured sits where the browser put it, not where the estimate
   * said, and the reader sees the browser's.
   */
  const capture = (): void => {
    if (box === undefined) return;
    // The DOM's own height, not the layout's, for the same reason.
    atEnd = nextAtEnd(atEnd, endDistance(box.scrollTop, box.clientHeight, box.scrollHeight));
    anchor =
      readDomAnchor(box, mounted) ??
      (shown === undefined ? undefined : anchorAt(shown.keys, shown.offsets, box.scrollTop));
  };

  const layout = rt.createMemo((): Layout => {
    measured();
    const keys = props.items.map((item) => props.itemKey(item));
    assertUniqueKeys(keys);
    const size = estimate();
    capture();
    const positions = new Map(keys.map((key, index) => [key, index]));
    pruneHeights(heights, positions);
    shown = {
      keys,
      positions,
      offsets: rowOffsets(keys.map((key) => heights.get(key) ?? size)),
    };
    return shown;
  });

  /**
   * Where the box WILL be scrolled under this layout: at the end for a following reader there,
   * else wherever keeps the anchored row in place. The range is drawn for that position, not the
   * stale one — drawn for the stale one, a prepend would unmount the very row being read (and the
   * focus inside it) before the scroll correction put it back.
   */
  const targetTop = (keys: readonly string[], offsets: readonly number[], box: number): number => {
    // Read before any branch: a memo tracks what its LAST run read, and a run that returned at the
    // end without reading the scroll position would never hear the reader scroll away from it.
    const scrolled = scrollTop();
    const total = offsets[offsets.length - 1] ?? 0;
    if (props.follow === true && atEnd) return Math.max(0, total - box);
    const anchored = anchor === undefined ? undefined : anchoredScrollTop(anchor, keys, offsets);
    return anchored ?? scrolled;
  };

  const range = rt.createMemo(() => {
    const { keys, offsets } = layout();
    const box = viewport();
    if (box === undefined) return { start: 0, end: offsets.length - 1 };
    return visibleRange(offsets, targetTop(keys, offsets, box), box, overscan());
  });

  const rowNode = (item: Accessor<T>, key: string): JSX.Element => (
    <li
      class={styles['row']}
      data-key={key}
      aria-setsize={layout().keys.length}
      aria-posinset={(layout().positions.get(key) ?? 0) + 1}
      ref={(el: HTMLLIElement) => {
        mounted.add(el);
        observer?.observe(el);
        rt.onCleanup(() => {
          mounted.delete(el);
          observer?.unobserve(el);
        });
      }}
    >
      {props.renderItem(item())}
    </li>
  );
  const rowNodes = keyedRows<T, JSX.Element>(rt, (item) => props.itemKey(item), rowNode);

  /** Where the box is now, as the next layout change will need it. */
  const settle = (): void => {
    if (box === undefined) return;
    layout();
    capture();
    setScrollTop(box.scrollTop);
    setBehind(props.follow === true && !atEnd);
  };

  rt.createEffect(() => {
    if (box === undefined) return;
    const target = box;
    observer = createVirtualListObserver(target, (sizes) => {
      let changed = false;
      for (const [key, size] of sizes.rows) {
        if (heights.get(key) !== size) {
          heights.set(key, size);
          changed = true;
        }
      }
      if (sizes.viewport !== undefined) setViewport(sizes.viewport);
      if (changed) setMeasured(measured() + 1);
    });
    for (const element of mounted) observer?.observe(element);
    setViewport(target.clientHeight);
    rt.onCleanup(() => observer?.disconnect());
  });

  // After every layout change AND every move of the drawn range: follow the end if the reader is
  // there, otherwise put the row they were reading back where it was. The range moves on its own
  // (the box measured, a scroll settled), and each move swaps drawn rows for estimated padding:
  // rows measured 31 px against a 48 px estimate left a follower 52 px short, which the hysteresis
  // then read as scrolled away. The platform's `overflow-anchor` is off; this is the one rule.
  rt.createEffect(() => {
    const { keys, offsets } = layout();
    range();
    if (box === undefined) return;
    if (props.follow === true && atEnd) {
      box.scrollTop = box.scrollHeight;
    } else if (anchor !== undefined) {
      const drawn = domRowOffset(box, mounted, anchor.key);
      const delta =
        drawn === undefined
          ? targetTop(keys, offsets, box.clientHeight) - box.scrollTop
          : anchorCorrection(anchor, drawn);
      if (Math.abs(delta) >= 1) box.scrollTop += delta;
    }
    settle();
  });

  const toEnd = (): void => {
    box?.scrollTo({ top: box.scrollHeight, behavior: scrollBehavior() });
  };

  return (
    <div class={cx(styles['wrap'], props.class)}>
      <div
        class={styles['box']}
        ref={(el: HTMLDivElement) => {
          box = el;
        }}
        onScroll={settle}
      >
        <ul
          class={styles['list']}
          // biome-ignore lint/a11y/noRedundantRoles: `list-style: none` drops the implicit role in WebKit
          role="list"
          aria-label={props.label}
          style={{
            '--virtual-before': px(layout().offsets[range().start] ?? 0),
            '--virtual-after': px(
              (layout().offsets[layout().keys.length] ?? 0) - (layout().offsets[range().end] ?? 0),
            ),
          }}
        >
          {rowNodes(props.items.slice(range().start, range().end))}
        </ul>
      </div>
      {behind() ? (
        <button type="button" class={styles['toEnd']} onClick={toEnd}>
          {ui.t(UI_KEYS.listToEnd)}
        </button>
      ) : null}
    </div>
  );
}
