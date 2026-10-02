/**
 * The client router's tie to the origin's other tabs: one `BroadcastChannel`, so a write or a new
 * principal in one tab empties every tab's prefetch cache. Closed while the page sits in the
 * back/forward cache (an open channel keeps a page out of it); reopened, cache emptied, on return.
 */

import { onClientWrite, onRescope } from '@ultimat3/core/page';

/** One channel per origin: a principal change or a write in one tab empties every tab's cache. */
export const NAVIGATION_CHANNEL = 'ultimate:navigation';

export interface TabSync {
  /** This tab and every other: a write or a new principal makes every held page suspect. */
  forget(): void;
  stop(): void;
}

/** `clear` empties this tab's cache; called for this tab's own events and every other tab's. */
export function tabSync(win: Window, clear: () => void): TabSync {
  const open = (): BroadcastChannel | undefined => {
    if (!('BroadcastChannel' in win)) return undefined;
    const opened = new BroadcastChannel(NAVIGATION_CHANNEL);
    opened.onmessage = clear;
    return opened;
  };
  let channel = open();
  const forget = (): void => {
    clear();
    channel?.postMessage('clear');
  };
  // `pagehide`, not `unload`: it fires for a page entering the back/forward cache too, and a page
  // holding an open channel is refused by it — Back then reloads the page from the network.
  const onHide = (): void => {
    channel?.close();
    channel = undefined;
  };
  // Restored from that cache: every message sent while it was frozen was missed, so nothing held
  // can be trusted. A `pageshow` of a fresh load finds the channel open and leaves it.
  const onShow = (event: PageTransitionEvent): void => {
    if (!event.persisted || channel !== undefined) return;
    channel = open();
    clear();
  };
  win.addEventListener('pagehide', onHide);
  win.addEventListener('pageshow', onShow);
  const offWrite = onClientWrite(forget);
  const offRescope = onRescope(forget);
  return {
    forget,
    stop() {
      win.removeEventListener('pagehide', onHide);
      win.removeEventListener('pageshow', onShow);
      offWrite();
      offRescope();
      onHide();
    },
  };
}
