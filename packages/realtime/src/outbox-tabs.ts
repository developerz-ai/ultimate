/**
 * The page outbox's tie to the origin's other tabs: one `BroadcastChannel`, on which a tab names
 * the scope whose durable queue it just changed, so every other tab re-reads it. Closed while the
 * page sits in the back/forward cache (an open channel keeps a page out of it); reopened on return.
 */

/** One channel per origin; a message is the scope key whose queue moved. */
export const OUTBOX_CHANNEL = 'ultimate:outbox';

export interface OutboxTabs {
  /** Tell every other tab that `scope`'s queue changed on disk. */
  announce(scope: string): void;
  stop(): void;
}

/** What this needs of a window: the channel class, when there is one, and the page events. */
export interface OutboxTabsWindow {
  readonly BroadcastChannel?: typeof BroadcastChannel;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/**
 * `heard(scope)` for every other tab's announcement; `heard(null)` on a page restored from the
 * back/forward cache, which missed everything sent while it was frozen.
 */
export function outboxTabs(
  win: OutboxTabsWindow,
  heard: (scope: string | null) => void,
): OutboxTabs {
  const Channel = win.BroadcastChannel;
  const open = (): BroadcastChannel | undefined => {
    if (Channel === undefined) return undefined;
    const opened = new Channel(OUTBOX_CHANNEL);
    opened.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') heard(event.data);
    };
    return opened;
  };
  let channel = open();
  // `pagehide`, not `unload`: it fires for a page entering the back/forward cache too, and a page
  // holding an open channel is refused by it.
  const onHide = (): void => {
    channel?.close();
    channel = undefined;
  };
  const onShow = (event: Event): void => {
    if (Reflect.get(event, 'persisted') !== true || channel !== undefined) return;
    channel = open();
    heard(null);
  };
  win.addEventListener('pagehide', onHide);
  win.addEventListener('pageshow', onShow);
  return {
    announce: (scope) => channel?.postMessage(scope),
    stop() {
      win.removeEventListener('pagehide', onHide);
      win.removeEventListener('pageshow', onShow);
      onHide();
    },
  };
}
