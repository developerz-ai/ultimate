// The controls a selectable list draws, shared by `DataTable` and `Board`: a native checkbox per
// row posting its key, the tick-all box, the `BulkBar`, the keyboard, and the prune that drops a
// row which left the list. One module, so a table and a board cannot drift on the gesture.
//
// Scripting off, every box is a plain form control in one form (`form`), and the submit is the
// caller's action button in the bar. With `onChange` the boxes are controlled and call back.

import type { JSX } from 'solid-js';
import { UI_KEYS } from '../i18n-keys';
import { useUi } from '../theme/context';
import { solid } from '../theme/solid-adapter';
import { BulkBar, type SelectionMatching } from './BulkBar';
import {
  isSelected,
  NO_SELECTION,
  pageState,
  pruneSelection,
  type RowSelection,
  selectedCount,
  selectionIntent,
  selectRange,
  toggleKey,
  togglePage,
} from './row-selection';
import styles from './selection-control.module.scss';

/** A list's selection: what each row's box posts, what is selected, and the bar's actions. */
export interface ListSelection<Item> {
  /** The field name each row's box posts its key under. */
  readonly name: string;
  /** The id of the `<form>` every box submits with — the bar's actions submit it. */
  readonly form?: string | undefined;
  /** What is selected now. Scripting off, the server's reading of the last post. */
  readonly value: RowSelection;
  /**
   * Callback mode: a click, Shift+click, a key or a long press answers the next selection, and a
   * row that left the list is pruned from it. Absent, the boxes are plain form controls.
   */
  readonly onChange?: ((next: RowSelection) => void) | undefined;
  /** Each row box's accessible name, already translated: "Select invoice 42". */
  readonly label: (item: Item) => string;
  /**
   * Present when the filter matches more rows than this page shows. Its box posts `filter` under
   * `name`; a server that receives it acts on the filter and ignores the row keys beside it.
   */
  readonly matching?: SelectionMatching | undefined;
  /** The bulk actions, in the bar. */
  readonly actions?: JSX.Element | undefined;
}

type BoxKeyEvent = KeyboardEvent & { currentTarget: HTMLInputElement };
type BoxClickEvent = MouseEvent & { currentTarget: HTMLInputElement };

/** The attribute the keyboard finds a row's box by, and the scope it searches within. */
export const SELECT_KEY_ATTR = 'data-select-key';
export const SELECTION_SCOPE_ATTR = 'data-selection-scope';

function focusBox(from: Element, key: string): void {
  const scope = from.closest(`[${SELECTION_SCOPE_ATTR}]`);
  if (scope === null) return;
  for (const box of scope.querySelectorAll<HTMLInputElement>(`input[${SELECT_KEY_ATTR}]`)) {
    if (box.getAttribute(SELECT_KEY_ATTR) === key) {
      box.focus();
      return;
    }
  }
}

export interface SelectionControls<Item> {
  /** A row's box; `item` is read inside the label, so a new object under the key relabels it. */
  box(item: () => Item, key: string): JSX.Element;
  /** The tick-all box — callback mode only: scripting off it could tick nothing. */
  pageBox(): JSX.Element;
  bar(): JSX.Element;
  /** The long press's toggle: one row, as a plain click on its box. */
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
  // The Shift range's fixed end: the last row clicked or moved to without Shift.
  let anchor: string | undefined;

  const current = (): RowSelection => {
    const s = selection();
    return s === undefined ? NO_SELECTION : s.value;
  };
  /** What the boxes show: never a key that left the list, never another filter's "all". */
  const shown = (): RowSelection =>
    pruneSelection(current(), visible(), selection()?.matching?.filter);
  const change = (next: RowSelection): void => selection()?.onChange?.(next);

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
    const keys = visible();
    const on = !isSelected(shown(), key);
    const next =
      event.shiftKey && anchor !== undefined
        ? selectRange(shown(), keys, anchor, key, on)
        : toggleKey(shown(), keys, key);
    anchor = key;
    change(next);
  };

  const onKeyDown = (key: string, event: BoxKeyEvent): void => {
    const intent = selectionIntent(event);
    if (intent === null) return;
    event.preventDefault();
    const keys = visible();
    if (intent === 'all' || intent === 'clear') {
      anchor = undefined;
      change(intent === 'all' ? togglePage(shown(), keys) : NO_SELECTION);
      return;
    }
    const at = keys.indexOf(key);
    const target = keys[intent === 'next' || intent === 'extend-next' ? at + 1 : at - 1];
    if (target === undefined) return;
    if (intent === 'extend-next' || intent === 'extend-prev') {
      change(selectRange(shown(), keys, anchor ?? key, target, true));
      anchor ??= key;
    } else {
      anchor = target;
    }
    focusBox(event.currentTarget, target);
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
        checked={isSelected(shown(), key)}
        aria-label={selection()?.label(item())}
        data-select-key={key}
        onClick={callbacks ? (event: BoxClickEvent) => onClick(key, event) : undefined}
        onKeyDown={callbacks ? (event: BoxKeyEvent) => onKeyDown(key, event) : undefined}
      />
    );
  };

  const pageBox = (): JSX.Element => {
    const state = (): ReturnType<typeof pageState> => pageState(shown(), visible());
    return (
      <input
        type="checkbox"
        class={styles['box']}
        aria-label={ui.t(UI_KEYS.selectionPage)}
        checked={state() === 'all'}
        // `indeterminate` has no attribute form, so "mixed" is ARIA's alone, as `Checkbox` does it.
        aria-checked={state() === 'some' ? 'mixed' : undefined}
        data-mixed={state() === 'some' ? 'true' : undefined}
        onClick={() => change(togglePage(shown(), visible()))}
      />
    );
  };

  /** Read through `selection()` at every use: the bar is built once and a new value updates it. */
  const bar = (): JSX.Element => {
    const callbacks = selection()?.onChange !== undefined;
    return (
      <BulkBar
        count={selectedCount(shown(), selection()?.matching?.count ?? 0)}
        matching={selection()?.matching}
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
    anchor = key;
    change(toggleKey(shown(), visible(), key));
  };

  return { box, pageBox, bar, toggle };
}
