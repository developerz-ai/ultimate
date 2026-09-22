// The engine ⇄ tab seam: the messages a `MessagePort` carries, the part of a port the engine uses,
// and what the engine remembers about each attached one. Shared by the engine and its router.

import type { SyncTarget } from './page-store';
import type { SubscribeFrame } from './sync-protocol';

/** The engine ⇄ tab messages. `frame.data` is a wire frame, encoded exactly as a socket carries it. */
export type PortMessage =
  | { readonly t: 'open'; readonly target: SyncTarget }
  | { readonly t: 'frame'; readonly data: string }
  | { readonly t: 'close'; readonly code: number }
  /** The tab is going away (`pagehide`, a principal change): release the port itself. */
  | { readonly t: 'bye' };

/** The part of a `MessagePort` the engine uses — so a test hands in a `MessageChannel` port. */
export interface PortLike {
  postMessage(message: PortMessage): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  close?(): void;
}

/** One tab, as the engine knows it. */
export interface AttachedPort {
  readonly id: number;
  readonly port: PortLike;
  /** The tab asked for its virtual socket to be open. */
  open: boolean;
  /** It has asked before: a later `open` is the tab's own retry, not a page arriving. */
  asked: boolean;
  lastSeen: number;
  /** Channel topics this port wants. */
  readonly topics: Set<string>;
  /** Engine sid → the add frame, for the live queries this port holds. */
  readonly lives: Map<string, SubscribeFrame>;
}

/**
 * A real `MessagePort` as a `PortLike`. Setting `onmessage` on a `MessagePort` starts it, which is
 * what both hosts rely on; the wrapper exists only because the DOM types a handler over
 * `MessageEvent` and the engine reads nothing of one but `data`.
 */
export function messagePort(port: MessagePort): PortLike {
  let handler: PortLike['onmessage'] = null;
  return {
    postMessage: (message) => port.postMessage(message),
    get onmessage() {
      return handler;
    },
    set onmessage(next) {
      handler = next;
      port.onmessage = next === null ? null : (event: MessageEvent) => next({ data: event.data });
    },
    close: () => port.close(),
  };
}
