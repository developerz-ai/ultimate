// What a SearchableSelect's field does on a key, a keystroke, a click and a blur — over accessors
// and setters it is handed, so the whole controller runs in a test with no DOM and no renderer.
// Focus never leaves the field: the active row is `aria-activedescendant`, never a focus move.

import type { SearchableView } from './searchable-select-view';
import { dropLast, firstActive, pickValue, stepActive } from './searchable-select-view';

export interface SearchableKeysState {
  view(): SearchableView;
  chosen(): readonly string[];
  multiple(): boolean;
  open(): boolean;
  active(): number;
  query(): string | null;
  setOpen(open: boolean): void;
  setActive(index: number): void;
  setQuery(query: string | null): void;
  commit(values: readonly string[]): void;
}

/** The slice of a `KeyboardEvent` the controller reads — a test builds one as a literal. */
export interface SearchableKey {
  readonly key: string;
  readonly altKey?: boolean;
  preventDefault(): void;
}

export interface SearchableKeys {
  onKeyDown(event: SearchableKey): void;
  typed(text: string): void;
  pickRow(index: number): void;
  toggle(): void;
  /** Blur and Tab: the list closes, nothing is picked, typed text is dropped. */
  close(): void;
}

const LIST_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp']);

export function searchableKeys(state: SearchableKeysState): SearchableKeys {
  const chosenRow = (): number => {
    const rows = state.view().rows;
    const index = rows.findIndex((row) => state.chosen().includes(row.option.value));
    return index >= 0 && rows[index]?.option.disabled !== true ? index : firstActive(rows);
  };
  const openList = (): void => {
    state.setOpen(true);
    state.setActive(chosenRow());
  };
  const close = (): void => {
    state.setOpen(false);
    state.setActive(-1);
    state.setQuery(null);
  };
  const pickRow = (index: number): void => {
    const row = state.view().rows[index];
    if (row === undefined || row.option.disabled === true) return;
    state.commit(pickValue(state.chosen(), row.option.value, state.multiple()));
    if (state.multiple()) {
      // Clearing the query redraws the list, so the old INDEX names another option: find the
      // picked one again by value, or the second Enter ticks a row the user never aimed at.
      state.setQuery(null);
      const rows = state.view().rows;
      const again = rows.findIndex((r) => r.option.value === row.option.value);
      state.setActive(again >= 0 ? again : firstActive(rows));
    } else close();
  };

  const onKeyDown = (event: SearchableKey): void => {
    const { key } = event;
    if (!state.open()) {
      // Home/End/PageUp/PageDown move the caret in a closed field; only the arrows open it.
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        openList();
      } else if (key === 'Escape' && state.query() !== null) {
        event.preventDefault();
        close();
      } else if (key === 'Backspace') removeLast();
      return;
    }
    if (LIST_KEYS.has(key)) {
      event.preventDefault();
      if (key === 'ArrowUp' && event.altKey === true) {
        close();
        return;
      }
      const next = stepActive(state.view().rows, state.active(), key);
      if (next !== undefined) state.setActive(next);
      return;
    }
    if (key === 'Enter') {
      // Open, Enter is a pick and never the form's submit.
      event.preventDefault();
      pickRow(state.active());
    } else if (key === 'Escape') {
      event.preventDefault();
      close();
    } else if (key === 'Tab') close();
    else if (key === 'Backspace') removeLast();
  };

  const removeLast = (): void => {
    if (!state.multiple() || (state.query() ?? '') !== '' || state.chosen().length === 0) return;
    state.commit(dropLast(state.chosen()));
  };

  return {
    onKeyDown,
    typed: (text) => {
      state.setQuery(text);
      state.setOpen(true);
      state.setActive(firstActive(state.view().rows));
    },
    pickRow,
    toggle: () => (state.open() ? close() : openList()),
    close,
  };
}
