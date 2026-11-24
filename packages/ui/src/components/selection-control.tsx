// The controls a selectable list draws, shared by `DataTable` and `Board`: a native checkbox per
// row posting its key, the tick-all box, the `BulkBar`, the keyboard, and the prune that drops a
// row which left the list. One module, so a table and a board cannot drift on the gesture.
//
// Scripting off, every box is a plain form control in one form (`form`), and the submit is the
// caller's action button in the bar. With `onChange` the boxes are controlled and call back.

import { renderCauseValue } from '@ultimat3/core';
import type { JSX } from 'solid-js';
import { UI_ERROR_CODES, UiError } from '../errors';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import { BulkBar, type SelectionMatching } from './BulkBar';
import {
  NO_SELECTION,
  pageState,
  pruneSelection,
  type RowSelection,
  selectedCount,
  selectionIntent,
  selectPage,
  selectRange,
  toggleKey,
  togglePage,
} from './row-selection';
import styles from './selection-control.module.scss';

/** A list's selection: what each row's box posts, what is selected, and the bar's actions. */
export interface ListSelection<Item> {
  /** The field name each row's box posts its key under. */
  readonly name: string;
  /**
   * The id of the `<form>` every box submits with — the bar's actions submit it. Omitted, the boxes
   * belong to the form around the list. A `Board` with `action` draws a `<form>` per card for its
   * no-script move, and the HTML parser drops a form nested in another: there the bulk form stands
   * apart from the board, named here, and its submit buttons carry `form` with the same id.
   */
  readonly form?: string | undefined;
  /** What is selected now. Scripting off, the server's reading of the last post. */
  readonly value: RowSelection;
  /**
   * Callback mode: a click, Shift+click, a key or a long press answers the next selection, and a
   * row that left the list is pruned from it. Absent, the boxes are plain form controls. A change
   * the caller declines leaves every box showing `value`, not the browser's own toggle.
   */
  readonly onChange?: ((next: RowSelection) => void) | undefined;
  /** Each row box's accessible name, already translated: "Select invoice 42". */
  readonly label: (item: Item) => string;
  /**
   * Present when the filter matches more rows than this page shows. Its box posts `filter` under
   * `matching.name`, which must differ from `name`; a server that receives it acts on the filter
   * and ignores the row keys beside it.
   */
  readonly matching?: SelectionMatching | undefined;
  /** The bulk actions, in the bar. */
  readonly actions?: JSX.Element | undefined;
}

type BoxKeyEvent = KeyboardEvent & { currentTarget: HTMLInputElement };
type BoxClickEvent = MouseEvent & { currentTarget: HTMLInputElement };

/** One field name for a row key and a filter: the server could not tell one row from all of them. */
function sharedNameError(name: string): UiError {
  return new UiError({
    code: UI_ERROR_CODES.invalidValue,
    cause: `selection.matching.name and selection.name are both ${renderCauseValue(name)}, so a posted value could be a row key or the filter and the server cannot tell which`,
    fix: "selection: { name: 'ids', matching: { name: 'all', filter, count } }   # two distinct field names",
  });
}

export interface SelectionControls<Item> {
  /** A row's box; `item` is read inside the label, so a new object under the key relabels it. */
  box(item: () => Item, key: string): JSX.Element;
  /** The tick-all box — callback mode only: scripting off it could tick nothing. */
  pageBox(): JSX.Element;
  bar(): JSX.Element;
  /** The long press's toggle: one row, as a plain click on its box. A row gone since is ignored. */
  toggle(key: string): void;
}

/**
 * Call once in the component body. `visible` is the keys on screen, in reading order; `settled`
 * false (a first page in flight) holds the prune, so a load never empties the selection.
 */
export function selectionControls<Item>(
  selection: () => ListSelection<Item> | undefined,
  visible: () => readonly string[],
  settled: () => boolean,
): SelectionControls<Item> {
  const ui = useUi();
  const rt = solid();
  // The Shift range's fixed end: the last row clicked, or moved to without Shift.
  let anchor: string | undefined;
  // The box the last gesture left focus on. Shift+Arrow from it continues the range; from any
  // other box — reached by Tab or a click elsewhere — it starts a new one there.
  let focusAt: string | undefined;
  // Each row's box by key, for the keyboard: this list's own boxes, never a nested list's.
  const boxes = new Map<string, HTMLInputElement>();

  const current = (): RowSelection => selection()?.value ?? NO_SELECTION;
  // Once per list, not once per row: every box and the tick-all box read the same answers.
  const keys = rt.createMemo(visible);
  /** What the boxes show: never a key that left the list, never another filter's "all". */
  const shown = rt.createMemo(
    (): RowSelection => pruneSelection(current(), keys(), selection()?.matching?.filter),
  );
  const ticked = rt.createMemo((): ReadonlySet<string> | 'all' => {
    const s = shown();
    return s.kind === 'matching' ? 'all' : new Set(s.keys);
  });
  const has = (key: string): boolean => {
    const set = ticked();
    return set === 'all' || set.has(key);
  };
  const state = (): ReturnType<typeof pageState> => pageState(shown(), keys());
  /** A gesture that changes nothing is not a change: no call back. */
  const change = (next: RowSelection): void => {
    if (next !== shown()) selection()?.onChange?.(next);
  };

  rt.createEffect(() => {
    const s = selection();
    if (s?.onChange === undefined || !settled()) return;
    const pruned = shown();
    if (pruned !== s.value) s.onChange(pruned);
  });

  const allMatching = (on: boolean): void => {
    const matching = selection()?.matching;
    change(
      on && matching !== undefined ? { kind: 'matching', filter: matching.filter } : NO_SELECTION,
    );
  };

  const onClick = (key: string, event: BoxClickEvent): void => {
    const next =
      event.shiftKey && anchor !== undefined
        ? selectRange(shown(), keys(), anchor, key, !has(key))
        : toggleKey(shown(), keys(), key);
    anchor = key;
    focusAt = key;
    change(next);
    // The browser has already flipped the box; it shows what the caller holds, accepted or not.
    event.currentTarget.checked = has(key);
  };

  const onKeyDown = (key: string, event: BoxKeyEvent): void => {
    const intent = selectionIntent(event);
    if (intent === null) return;
    event.preventDefault();
    const list = keys();
    if (intent === 'all' || intent === 'clear') {
      anchor = undefined;
      focusAt = undefined;
      change(intent === 'all' ? selectPage(shown(), list) : NO_SELECTION);
      return;
    }
    const at = list.indexOf(key);
    const target = list[intent === 'next' || intent === 'extend-next' ? at + 1 : at - 1];
    if (target === undefined) return;
    if (intent === 'extend-next' || intent === 'extend-prev') {
      const from = focusAt === key && anchor !== undefined ? anchor : key;
      anchor = from;
      change(selectRange(shown(), list, from, target, true));
    } else {
      anchor = target;
    }
    focusAt = target;
    boxes.get(target)?.focus();
  };

  const track = (key: string, el: HTMLInputElement): void => {
    boxes.set(key, el);
    rt.onCleanup(() => {
      if (boxes.get(key) === el) boxes.delete(key);
    });
  };

  const box = (item: () => Item, key: string): JSX.Element => {
    const callbacks = selection()?.onChange !== undefined;
    return (
      <input
        type="checkbox"
        class={styles['box']}
        name={selection()?.name}
        value={key}
        form={selection()?.form}
        checked={has(key)}
        aria-label={selection()?.label(item())}
        ref={(el: HTMLInputElement) => track(key, el)}
        onClick={callbacks ? (event: BoxClickEvent) => onClick(key, event) : undefined}
        onKeyDown={callbacks ? (event: BoxKeyEvent) => onKeyDown(key, event) : undefined}
      />
    );
  };

  /** `indeterminate` is a property with no attribute: set here, beside ARIA's "mixed". */
  const paint = (el: HTMLInputElement): void => {
    el.checked = state() === 'all';
    el.indeterminate = state() === 'some';
  };

  const pageBox = (): JSX.Element => (
    <input
      type="checkbox"
      class={styles['box']}
      aria-label={ui.t(UI_KEYS.selectionPage)}
      checked={state() === 'all'}
      // A first page in flight, or an empty one, has nothing to tick.
      disabled={keys().length === 0}
      aria-checked={state() === 'some' ? 'mixed' : undefined}
      data-mixed={state() === 'some' ? 'true' : undefined}
      ref={(el: HTMLInputElement) => rt.createEffect(() => paint(el))}
      onClick={(event: BoxClickEvent) => {
        change(togglePage(shown(), keys()));
        paint(event.currentTarget);
      }}
    />
  );

  /** "All matching" posts under its own name: the same name as a row key's could not be told apart. */
  const matchingOf = (): SelectionMatching | undefined => {
    const s = selection();
    const matching = s?.matching;
    if (matching !== undefined && matching.name === s?.name) throw sharedNameError(matching.name);
    return matching;
  };

  /**
   * Read through `selection()` at every use: the bar is built once and a new value updates it.
   * Scripting off it carries no count — the boxes change and nothing could recount them.
   */
  const bar = (): JSX.Element => {
    const callbacks = selection()?.onChange !== undefined;
    return (
      <BulkBar
        count={callbacks ? selectedCount(shown(), selection()?.matching?.count ?? 0) : undefined}
        matching={matchingOf()}
        allMatching={shown().kind === 'matching'}
        form={selection()?.form}
        onAllMatching={callbacks ? allMatching : undefined}
        onClear={callbacks ? () => change(NO_SELECTION) : undefined}
      >
        {selection()?.actions}
      </BulkBar>
    );
  };

  const toggle = (key: string): void => {
    if (!keys().includes(key)) return;
    anchor = key;
    focusAt = undefined;
    change(toggleKey(shown(), keys(), key));
  };

  return { box, pageBox, bar, toggle };
}
