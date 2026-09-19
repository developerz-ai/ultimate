// The rules of a command palette, apart from its markup: which items a query keeps, where the
// roving selection goes on an arrow key, and what a key means. Pure, so the caller's island and
// a page test decide the same thing — and so the component owns no rule a caller could get wrong.

export interface CommandPaletteItem {
  /** Stable across a re-filter — what roving selection and `onRunItem` both key off. */
  readonly id: string;
  readonly label: string;
  /** Secondary text — a target URL, a slug, a key chord. Empty renders nothing. */
  readonly hint: string;
}

/** Case-insensitive substring over label and hint; an empty query keeps everything. */
export function filterItems(
  items: readonly CommandPaletteItem[],
  query: string,
): readonly CommandPaletteItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return items;
  return items.filter(
    (item) => item.label.toLowerCase().includes(needle) || item.hint.toLowerCase().includes(needle),
  );
}

/** The active id after a step, wrapping at both ends; the first item when nothing was active. */
export function stepActive(
  items: readonly CommandPaletteItem[],
  activeId: string | undefined,
  delta: 1 | -1,
): string | undefined {
  if (items.length === 0) return undefined;
  const index = items.findIndex((item) => item.id === activeId);
  const next = index === -1 ? 0 : (index + delta + items.length) % items.length;
  return items[next]?.id;
}

/** The active id a narrowed list should keep: the same one if it survived, else the first. */
export function settleActive(
  items: readonly CommandPaletteItem[],
  activeId: string | undefined,
): string | undefined {
  return items.some((item) => item.id === activeId) ? activeId : items[0]?.id;
}

export type PaletteKeyAction = 'next' | 'previous' | 'run' | 'close';

/** What a key pressed in the filter means, or `null` for a key the palette does not own. */
export function keyAction(key: string): PaletteKeyAction | null {
  switch (key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'previous';
    case 'Enter':
      return 'run';
    case 'Escape':
      return 'close';
    default:
      return null;
  }
}
