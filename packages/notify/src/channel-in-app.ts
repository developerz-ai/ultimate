// The in-app inbox as a channel. `noticed` writes a notification row unconditionally; here it is
// an opt-in channel, so a notifier that only sends email writes no rows at all — one mechanism,
// declared where every other delivery is declared, rather than a table that fills itself.

import type { NotifyChannel } from './channel';
import { channel } from './channel';
import { requireInbox } from './stores';

export interface InAppChannelOptions {
  /** The ledger and preference key this delivery is known by. Change it only to run two inbox
   * channels on one notifier — e.g. a per-org feed beside a personal one. */
  readonly name?: string | undefined;
}

export const IN_APP_CHANNEL = 'in-app';

export function inAppChannel<Params = unknown>(
  options: InAppChannelOptions = {},
): NotifyChannel<Params> {
  return channel<Params>(options.name ?? IN_APP_CHANNEL, async ({ recipient, batch }) => {
    // Every event in the batch, not just the newest: a digest window over an inbox still owes the
    // reader one row per thing that happened. `add` is idempotent on (recipient, notifier, key),
    // so a replayed attempt writes nothing new and does not move an existing row's timestamps.
    for (const entry of batch) {
      await requireInbox(entry.notifier).add({
        recipient: recipient.id,
        notifier: entry.notifier,
        key: entry.key,
        params: entry.params,
        createdAt: entry.at,
      });
    }
  });
}
