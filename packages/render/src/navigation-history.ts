/**
 * The client router's history entries: its own slot in `history.state` (the scroll offset and the
 * document the entry shows), how an entry is read back, how the scroll is saved into the entry of
 * the page ON SCREEN, and where a page lands. Split from `navigation.ts` so that file is the
 * controller and nothing else.
 */

import { isJsonObject } from '@ultimat3/core/page';
import { decodeSegment } from './decode-segment';

/** The router's own slot in `history.state`, beside whatever an app keeps there. */
export const STATE_KEY = '__x';

export interface EntryState {
  readonly scroll: readonly [number, number];
  /** The document this entry shows — what back/forward compares with the one on screen. */
  readonly doc: string;
  /** The modal open over `doc` (`navigation-modal-rules.ts`), on an entry this router pushed. */
  readonly modal?: string;
}

/** Back/forward, as the router passes it: `none` restores; the others start at the top. */
export type HistoryMode = 'push' | 'replace' | 'none' | undefined;

export const withoutFragment = (url: string): string => url.split('#')[0] ?? url;

/** The router's entry in a `history.state`, or `undefined` for an entry an app pushed. */
export const entryOf = (state: unknown): EntryState | undefined => {
  const entry = isJsonObject(state) ? state[STATE_KEY] : undefined;
  return isJsonObject(entry) && typeof entry['doc'] === 'string'
    ? (entry as unknown as EntryState)
    : undefined;
};

/**
 * The scroll offset, into the entry of the document `rendered` — never into another's: between a
 * back/forward and its swap, the current entry is the next page's, and this offset is not its.
 */
export function saveEntryScroll(win: Window, rendered: string): void {
  const state = (win.history.state ?? {}) as Record<string, unknown>;
  const held = entryOf(state)?.doc;
  if (held !== undefined && held !== rendered) return;
  // Spread: the entry's modal mark is what lets Escape go Back (`navigation-modal.ts`).
  const entry: EntryState = {
    ...entryOf(state),
    scroll: [win.scrollX, win.scrollY],
    doc: held ?? rendered,
  };
  win.history.replaceState({ ...state, [STATE_KEY]: entry }, '');
}

/**
 * The entry a swapped-in page gets: pushed for a new visit, replaced for the same URL (or when
 * asked), none on a back/forward — whose entry already names the page.
 */
export function recordEntry(win: Window, landed: string, doc: string, mode: HistoryMode): void {
  if (mode === 'none') return;
  const same = landed === win.location.href || mode === 'replace';
  const state = { [STATE_KEY]: { scroll: [0, 0], doc } satisfies EntryState };
  if (same) win.history.replaceState(state, '', landed);
  else win.history.pushState(state, '', landed);
}

/**
 * Where the new page lands: the saved offset on back/forward, the fragment's element, else the
 * top. `instant`, whatever the page's `scroll-behavior` says — `@ultimat3/ui`'s reset makes it
 * `smooth`, and a new page is a new place, which a full load jumps to rather than glides to.
 */
export function scrollAfter(win: Window, doc: Document, url: string, mode: HistoryMode): void {
  const raw = new URL(url).hash.slice(1);
  // A malformed escape (`#50%`) is the raw id, as the browser's own fragment lookup reads it: a
  // throw here is inside the swap, after the body was replaced and before any script ran.
  const target = raw === '' ? null : doc.getElementById(decodeSegment(raw) ?? raw);
  const saved = entryOf(win.history.state);
  const to = (left: number, top: number): void =>
    win.scrollTo({ left, top, behavior: 'instant' as ScrollBehavior });
  if (mode === 'none' && saved !== undefined) to(saved.scroll[0], saved.scroll[1]);
  else if (target !== null) target.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
  else to(0, 0);
}

/**
 * `url` loaded for real. One that differs from the page on screen only by its fragment is reloaded:
 * `assign` there is a same-document fragment navigation, which scrolls and leaves the page as it is.
 * An empty fragment (`/a#`) is one too, though `URL.hash` reads it as none.
 */
export function loadForReal(win: Window, url: string): void {
  const here = win.location.href;
  if (url.includes('#') && withoutFragment(url) === withoutFragment(here)) {
    win.location.reload();
  } else win.location.assign(url);
}

/**
 * The fragment's element, scrolled to once a hole brings it — when the swap found none to scroll to
 * and the visitor has not moved since: `true` once there is nothing left to wait for. Back/Forward
 * restored a saved offset, which a late element never overrides.
 */
export function lateFragment(
  win: Window,
  doc: Document,
  url: string,
  mode: HistoryMode,
): (() => boolean) | undefined {
  const raw = new URL(url).hash.slice(1);
  if (raw === '' || mode === 'none') return undefined;
  const id = decodeSegment(raw) ?? raw;
  if (doc.getElementById(id) !== null) return undefined;
  const at = [win.scrollX, win.scrollY, win.location.hash] as const;
  return () => {
    if (win.scrollX !== at[0] || win.scrollY !== at[1] || win.location.hash !== at[2]) return true;
    const target = doc.getElementById(id);
    if (target === null) return false;
    target.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
    return true;
  };
}
