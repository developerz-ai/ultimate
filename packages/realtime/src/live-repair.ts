// The registry's two repair paths, each window in its own lane: one socket's marked subscriptions
// when it can take a frame again (Bun's `drain`), and the node's sweep over every window owing a
// mark. Split from `live-query.ts` at its size ceiling: the registry owns the tables, this owns
// what a repair does with them.

import type { LiveEntries } from './live-entries';
import { type FanoutDeps, repairSubscriber, repairWindow } from './live-fanout';
import type { SyncSocket } from './socket';
import type { SubscriptionBook } from './subscription-book';

/**
 * This socket's marked subscriptions, repaired now. Frames that left. Every lane is entered before
 * any is awaited, as `deliverChange` does, so one slow policy pass holds up its own query id and
 * nothing else.
 */
export async function repairSocket(
  fanout: FanoutDeps,
  book: SubscriptionBook,
  entries: LiveEntries,
  socket: SyncSocket,
): Promise<number> {
  const repairs = [...socket.desynced].map(async (sid) => {
    const subscription = book.get(socket.id, sid);
    const entry = subscription && entries.get(subscription.qid);
    if (!subscription || !entry) return false;
    // Its rows are about to be replaced, so wait: this drain is the only one coming. Bounded by
    // the read's own deadline, and a read that failed staled the window, which refuses below.
    await entry.reading?.result.catch(() => undefined);
    return await entry.lock.run(() => repairSubscriber(fanout, entry, subscription));
  });
  return (await Promise.all(repairs)).filter(Boolean).length;
}

/** The node's sweep: every window owing a mark, each in its lane, one read a window at most. */
export async function repairEveryWindow(fanout: FanoutDeps, entries: LiveEntries): Promise<number> {
  const lanes = [...entries.values()].map((entry) =>
    entry.lock.run(() => repairWindow(fanout, entry)),
  );
  let sent = 0;
  let failure: { readonly error: unknown } | null = null;
  for (const lane of await Promise.allSettled(lanes)) {
    if (lane.status === 'fulfilled') sent += lane.value;
    else failure ??= { error: lane.reason };
  }
  if (failure !== null) throw failure.error;
  return sent;
}
