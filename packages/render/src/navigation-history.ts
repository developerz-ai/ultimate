/**
 * The client router's history entries: its own slot in `history.state` (the scroll offset and the
 * document the entry shows), how an entry is read back, how the scroll is saved into the entry of
 * the page ON SCREEN, and where a page lands. Split from `navigation.ts` so that file is the
 * controller and nothing else.
 */

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The router's entry in a `history.state`, or `undefined` for an entry an app pushed. */
export const entryOf = (state: unknown): EntryState | undefined => {
  const entry = isRecord(state) ? state[STATE_KEY] : undefined;
  return isRecord(entry) && typeof entry['doc'] === 'string'
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
 * Where the new page lands: the saved offset on back/forward, the fragment's element, else the
 * top. `instant`, whatever the page's `scroll-behavior` says — `@ultimat3/ui`'s reset makes it
 * `smooth`, and a new page is a new place, which a full load jumps to rather than glides to.
 */
export function scrollAfter(win: Window, doc: Document, url: string, mode: HistoryMode): void {
  const hash = new URL(url).hash;
  const target = hash.length > 1 ? doc.getElementById(decodeURIComponent(hash.slice(1))) : null;
  const saved = entryOf(win.history.state);
  const to = (left: number, top: number): void =>
    win.scrollTo({ left, top, behavior: 'instant' as ScrollBehavior });
  if (mode === 'none' && saved !== undefined) to(saved.scroll[0], saved.scroll[1]);
  else if (target !== null) target.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
  else to(0, 0);
}
