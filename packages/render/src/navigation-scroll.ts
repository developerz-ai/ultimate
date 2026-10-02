/**
 * The client router's scroll keeping: the browser's own restoration is off, so the router restores
 * a saved offset when a document LOADS onto one of its entries (reload, or Back after a full load),
 * then saves the offset into the entry on screen as the visitor scrolls.
 */

import { entryOf, saveEntryScroll } from './navigation-history';

export interface ScrollKeeper {
  /** The offset, into the entry of the document on screen now. */
  save(): void;
  /** Drops a save still pending — it belongs to the entry just left. */
  cancel(): void;
  stop(): void;
}

/** How long a scroll must rest before it is saved: a browser caps `replaceState` calls. */
const SCROLL_SETTLE_MS = 150;

export function scrollKeeper(win: Window, rendered: () => string): ScrollKeeper {
  win.history.scrollRestoration = 'manual';
  // BEFORE the first save. With restoration manual, a reload or a Back that is a full load lands
  // at the top, and the save below then overwrote the entry's offset with that 0 — the place the
  // visitor left was lost twice. Only this document's own entry: one an app pushed has no offset.
  const held = entryOf(win.history.state);
  if (held !== undefined && held.doc === rendered()) {
    win.scrollTo({
      left: held.scroll[0],
      top: held.scroll[1],
      behavior: 'instant' as ScrollBehavior,
    });
  }
  const save = (): void => saveEntryScroll(win, rendered());
  save();
  // Saved as the visitor scrolls, once the scroll settles — so FORWARD restores too.
  let settle: number | undefined;
  const cancel = (): void => win.clearTimeout(settle);
  const onScroll = (): void => {
    cancel();
    settle = win.setTimeout(save, SCROLL_SETTLE_MS);
  };
  win.addEventListener('scroll', onScroll, { passive: true });
  return {
    save,
    cancel,
    stop() {
      cancel();
      win.removeEventListener('scroll', onScroll);
    },
  };
}
