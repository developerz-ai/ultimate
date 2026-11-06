// The reader's place, read off the DOM: the first drawn row still showing at the box's top edge,
// and how far that edge is into it. The layout's numbers are estimates until a row is measured;
// the DOM is what the reader sees, so it is what a correction has to hold still.

import type { ScrollAnchor } from './virtual-list-view';

/** The drawn row the box's top edge falls in; `undefined` with no row drawn. */
export function readDomAnchor(
  box: HTMLElement,
  rows: Iterable<HTMLElement>,
): ScrollAnchor | undefined {
  const edge = box.getBoundingClientRect().top;
  let best: { readonly key: string; readonly top: number } | undefined;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    const key = row.dataset['key'];
    if (key === undefined || rect.bottom <= edge) continue;
    if (best === undefined || rect.top < best.top) best = { key, top: rect.top };
  }
  return best === undefined ? undefined : { key: best.key, within: edge - best.top };
}

/** Where row `key` sits now, relative to the box's top edge; `undefined` when it is not drawn. */
export function domRowOffset(
  box: HTMLElement,
  rows: Iterable<HTMLElement>,
  key: string,
): number | undefined {
  for (const row of rows) {
    if (row.dataset['key'] === key) {
      return row.getBoundingClientRect().top - box.getBoundingClientRect().top;
    }
  }
  return undefined;
}
