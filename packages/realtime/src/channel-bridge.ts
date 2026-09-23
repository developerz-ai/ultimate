// One topic's transport bridge into this node — the shape `ChannelHub` refcounts, and its safe
// close.

import type { TransportSubscription } from './fanout';

/**
 * One topic's fanout into this node. `sub` is the transport subscription as a PROMISE, published
 * into the table before it is awaited: looked up before the await and written after it, two sockets
 * reaching one topic at once opened two transport subscriptions — the second replacing the first in
 * the table, and the first then unreachable by `#release`, by a socket dying, by `close()` or by
 * anything else, delivering every message on that topic a second time for the life of the process.
 *
 * `null` means the slot is taken and nothing is open yet: the node cap is decided before the guard
 * runs, so the reservation has to exist before there is anything to reserve it with.
 */
export interface Bridge {
  sub: Promise<TransportSubscription> | null;
  refs: number;
}

/**
 * A bridge released while its subscription is still opening still has to be closed — the transport
 * hands the handle back after the caller has gone, and dropping the promise would leave a live
 * subscription this node can no longer name. An open that failed has nothing to unsubscribe and its
 * rejection was already answered to the subscriber that caused it.
 */
export function unsubscribeWhenOpen(bridge: Bridge): void {
  void bridge.sub?.then(
    (sub) => {
      sub.unsubscribe();
    },
    () => undefined,
  );
}
