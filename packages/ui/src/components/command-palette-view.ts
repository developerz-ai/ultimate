// The rules of a command palette, apart from its markup: which items a query keeps, where the
// roving selection goes on an arrow key, and what a key means. Pure, so the caller's island and
// a page test decide the same thing — and so the component owns no rule a caller could get wrong.

import { rankOptions } from './rank-options';

export interface CommandPaletteItem {
  /** Stable across a re-filter — what roving selection and `onRunItem` both key off. */
  readonly id: string;
  readonly label: string;
  /** Secondary text — a target URL, a slug, a key chord. Empty renders nothing. */
  readonly hint: string;
  /** Already-translated heading the item sits under; items of one group render together. */
  readonly group?: string | undefined;
  /** Words a reader may type that the label never shows — matched, never rendered. */
  readonly keywords?: readonly string[] | undefined;
}

/** A run of items under one heading; `group` is `undefined` for the ungrouped run. */
export interface CommandPaletteGroup {
  readonly group: string | undefined;
  readonly items: readonly CommandPaletteItem[];
}

/**
 * `rankOptions` over label, hint and keywords — the ranker `SearchableSelect` uses, so `cafe`
 * finds `Café` — then regrouped: a group keeps the place its first item had in the caller's list,
 * and the rank decides the order inside it. An empty query keeps everything, in order.
 */
export function filterItems(
  items: readonly CommandPaletteItem[],
  query: string,
): readonly CommandPaletteItem[] {
  const ranked = rankOptions(
    items.map((item) => ({
      label: item.label,
      description: item.hint,
      keywords: item.keywords,
      item,
    })),
    query,
    items.length,
  ).matches.map((entry) => entry.item);
  const order = new Map<string | undefined, number>();
  for (const item of items) if (!order.has(item.group)) order.set(item.group, order.size);
  return ranked
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (order.get(a.item.group) ?? 0) - (order.get(b.item.group) ?? 0) || a.index - b.index,
    )
    .map((entry) => entry.item);
}

/** Consecutive items sharing a `group`, as the palette renders them under one heading each. */
export function groupItems(items: readonly CommandPaletteItem[]): readonly CommandPaletteGroup[] {
  const out: { group: string | undefined; items: CommandPaletteItem[] }[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last !== undefined && last.group === item.group) last.items.push(item);
    else out.push({ group: item.group, items: [item] });
  }
  return out;
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
