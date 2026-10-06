// Where each DataTable value is visible, by the table's own width. A column's `priority` hides its
// cell in a narrow table; the row's "more" disclosure shows the same value for exactly the widths
// the cell is gone, so no value is ever on screen twice and none is ever nowhere.

import { invalidValueError } from '../errors';

/**
 * The roles every DataTable element re-declares. Redundant on a table laid out as a table, and
 * deliberately so: below `sm` the card view changes `display` on the table, its row groups, rows
 * and cells, and WebKit drops the implicit table semantics of an element whose `display` changed —
 * a screen reader then meets loose text with no row, no column and no header. The explicit role is
 * the documented remedy, and ONE constant is the one place the redundancy is argued, rather than a
 * lint suppression on every element.
 */
export const TABLE_ROLES = {
  rowgroup: 'rowgroup',
  row: 'row',
  columnheader: 'columnheader',
  cell: 'cell',
} as const;

/** 1 is always a cell; 2 is a cell from `md` up; 3 from `lg` up. Widths are the TABLE's. */
export const COLUMN_PRIORITIES = [1, 2, 3] as const;
export type ColumnPriority = (typeof COLUMN_PRIORITIES)[number];

/**
 * The `data-priority` / `data-more` values the stylesheet's width rules select on. Attributes, not
 * classes: they are state the markup carries, and a test can read them where a CSS-module class
 * resolves to nothing under `bun test`.
 */
export type PriorityAttr = '2' | '3';
/** The rung the disclosure shows below — the widest range any of its columns is hidden over. */
export type MoreUntil = 'md' | 'lg';

/**
 * The priority a column declared, refused when it is not one: the type stops a TypeScript caller,
 * and nothing stops a column list parsed from config — a `priority: 4` used to be a column shown
 * at every width with no word that it was not what was asked for.
 */
export function columnPriority(priority: unknown): ColumnPriority {
  if (priority === undefined) return 1;
  if (priority === 1 || priority === 2 || priority === 3) return priority;
  throw invalidValueError('DataTable', priority, 'a column priority of 1, 2 or 3');
}

/** What a cell (and its header) carries; priority 1 carries nothing and is never hidden. */
export function priorityAttr(priority: ColumnPriority): PriorityAttr | undefined {
  return priority === 1 ? undefined : `${priority}`;
}

export interface MoreColumn<C> {
  /** The columns whose values the disclosure may hold, in declaration order. */
  readonly columns: readonly C[];
  readonly until: MoreUntil;
}

/**
 * The trailing "more" column, or `undefined` when every column is priority 1 — a table that
 * hides nothing gets no extra column, no extra header and no extra bytes.
 */
export function moreColumn<C extends { readonly priority?: unknown }>(
  columns: readonly C[],
): MoreColumn<C> | undefined {
  const hidden = columns.filter((column) => columnPriority(column.priority) > 1);
  if (hidden.length === 0) return undefined;
  const widest = Math.max(...hidden.map((column) => columnPriority(column.priority)));
  return { columns: hidden, until: widest === 3 ? 'lg' : 'md' };
}
