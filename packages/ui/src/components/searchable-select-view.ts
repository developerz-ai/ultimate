// The rules of a SearchableSelect, apart from its markup: which options a query shows and in what
// order, where the active row moves on a key, what a pick does to the chosen values, and which
// option lists are refused. Pure, so the listbox and the no-script `<select>` read one answer.

import { renderCauseValue } from '@ultimat3/core';
import { UI_ERROR_CODES, UiError } from '../errors';
import type { RankableOption } from './rank-options';
import { rankOptions } from './rank-options';

export interface SearchableOption extends RankableOption {
  /** What the form posts. Unique within `options`. */
  readonly value: string;
  /** Already translated: the visible row text and, once picked, the field's text. */
  readonly label: string;
  /** A group's name, already translated. A group's options must be adjacent in `options`. */
  readonly group?: string | undefined;
  readonly disabled?: boolean | undefined;
}

/** One rendered row: the option, and the group heading it opens (`undefined` mid-group). */
export interface SearchableRow {
  readonly option: SearchableOption;
  readonly opensGroup: string | undefined;
}

export interface SearchableView {
  readonly rows: readonly SearchableRow[];
  /** Matches before the cap; above `rows.length` the control says "first N of M". */
  readonly total: number;
}

function refused(cause: string): UiError {
  return new UiError({
    code: UI_ERROR_CODES.invalidValue,
    cause,
    fix: 'options: [...loaded, ...chosen.filter((o) => !loaded.some((l) => l.value === o.value))]   # <SearchableSelect>: unique values, each group adjacent, every chosen value among them',
  });
}

/**
 * Refuses an option list the control cannot render honestly: two options under one value (a pick
 * could post either), a group split in two (two headings with one name), and a chosen value that
 * names no option — under `onSearch` the caller must keep the chosen options in what it hands back.
 */
export function checkOptions(
  options: readonly SearchableOption[],
  chosen: readonly string[],
): void {
  const values = new Set<string>();
  const closed = new Set<string>();
  let open: string | undefined;
  for (const option of options) {
    if (values.has(option.value)) {
      throw refused(
        `<SearchableSelect> has two options with value ${renderCauseValue(option.value)}`,
      );
    }
    values.add(option.value);
    if (option.group === open) continue;
    if (open !== undefined) closed.add(open);
    if (option.group !== undefined && closed.has(option.group)) {
      throw refused(
        `<SearchableSelect> group ${renderCauseValue(option.group)} is split: its options are not adjacent, at value ${renderCauseValue(option.value)}`,
      );
    }
    open = option.group;
  }
  for (const value of chosen) {
    if (!values.has(value)) {
      throw refused(
        `<SearchableSelect> value ${renderCauseValue(value)} names no option in options`,
      );
    }
  }
}

/**
 * The rows a query shows: ranked, capped, then regathered by group in the order groups first
 * appear — a ranked list would otherwise open one group three times. Within a group, rank order.
 */
export function searchableView(
  options: readonly SearchableOption[],
  query: string,
  limit: number,
): SearchableView {
  const ranked = rankOptions(options, query, limit);
  const order: (string | undefined)[] = [];
  const byGroup = new Map<string | undefined, SearchableOption[]>();
  for (const option of ranked.matches) {
    const bucket = byGroup.get(option.group);
    if (bucket === undefined) {
      order.push(option.group);
      byGroup.set(option.group, [option]);
    } else bucket.push(option);
  }
  const rows = order.flatMap((group) =>
    (byGroup.get(group) ?? []).map((option, i) => ({
      option,
      opensGroup: i === 0 ? group : undefined,
    })),
  );
  return { rows, total: ranked.total };
}

/** Rows a PageUp / PageDown skips: about one open listbox's height. */
export const SEARCHABLE_PAGE = 10;

const enabled = (rows: readonly SearchableRow[], index: number): boolean =>
  rows[index] !== undefined && rows[index]?.option.disabled !== true;

/** The first enabled row at or after `from` walking by `step`; -1 when none, never wrapping. */
function seek(rows: readonly SearchableRow[], from: number, step: 1 | -1): number {
  for (let i = from; i >= 0 && i < rows.length; i += step) if (enabled(rows, i)) return i;
  return -1;
}

/**
 * Where the active row goes on `key`, over ENABLED rows only (`roving.ts`'s rule: a disabled row
 * that can be active pins the walk). Arrows wrap; Home/End and the page keys stop at the ends.
 * `-1` is no active row; `undefined` is a key this rule does not own.
 */
export function stepActive(
  rows: readonly SearchableRow[],
  active: number,
  key: string,
): number | undefined {
  const first = seek(rows, 0, 1);
  const last = seek(rows, rows.length - 1, -1);
  switch (key) {
    case 'ArrowDown': {
      const next = active < 0 ? -1 : seek(rows, active + 1, 1);
      return next === -1 ? first : next;
    }
    case 'ArrowUp': {
      const next = active < 0 ? -1 : seek(rows, active - 1, -1);
      return next === -1 ? last : next;
    }
    case 'Home':
      return first;
    case 'End':
      return last;
    case 'PageDown': {
      const to = seek(rows, Math.min(rows.length - 1, Math.max(0, active) + SEARCHABLE_PAGE), -1);
      return to <= active ? last : to;
    }
    case 'PageUp': {
      const to = seek(rows, Math.max(0, active - SEARCHABLE_PAGE), 1);
      return to === -1 || to >= active ? first : to;
    }
    default:
      return undefined;
  }
}

/** The row a fresh query lands on: the best enabled match, so Enter picks what the eye sees first. */
export function firstActive(rows: readonly SearchableRow[]): number {
  return seek(rows, 0, 1);
}

/** A pick. One value replaces; under `multiple` a chosen value is removed, a new one appended. */
export function pickValue(
  chosen: readonly string[],
  value: string,
  multiple: boolean,
): readonly string[] {
  if (!multiple) return [value];
  return chosen.includes(value) ? chosen.filter((v) => v !== value) : [...chosen, value];
}

/** Backspace on an empty query: the newest chip goes. */
export function dropLast(chosen: readonly string[]): readonly string[] {
  return chosen.slice(0, -1);
}

/** The option behind each chosen value, in chosen order; a value no option names is skipped. */
export function chosenOptions(
  options: readonly SearchableOption[],
  chosen: readonly string[],
): readonly SearchableOption[] {
  const byValue = new Map(options.map((option) => [option.value, option] as const));
  return chosen.flatMap((value) => byValue.get(value) ?? []);
}

/** A row's element id: derived from the control's own id and the row's index, never its value. */
export function rowId(base: string, index: number): string {
  return `${base}-row-${index}`;
}
