// The digest branch of the fan-out: append every allowed recipient's event to its window, and let
// whichever run OPENED a window own the flush.
//
// Exactly one run opens a given window, so exactly one sleeps on it — which is what stops fifty
// events in one hour from scheduling fifty flushes of the same digest.

import { attemptDelivery } from './attempt';
import type { NotifyChannel } from './channel';
import type { DigestSlot } from './digest';
import type { Walk } from './fanout-walk';
import type { NotifyEvent, Recipient } from './notification';
import type { ResolvedDelivery } from './plan';
import { notifyStores, requireDigest } from './stores';

export interface DigestFlush<Params> {
  readonly walk: Walk<Params>;
  readonly channel: NotifyChannel<Params>;
  readonly delivery: ResolvedDelivery<Params>;
  readonly allowed: readonly Recipient[];
}

export async function flushDigest<Params>(input: DigestFlush<Params>): Promise<void> {
  const { walk, channel, delivery, allowed } = input;
  const { plan, event, ctx, step, tally } = walk;
  const windowMs = delivery.digestMs ?? 0;
  const digest = requireDigest(plan.name);
  const group = delivery.group?.(event) ?? plan.name;
  const slotFor = (recipient: string): DigestSlot => ({
    recipient,
    notifier: plan.name,
    channel: channel.name,
    group,
  });

  // One step for the whole append pass: appending is what a replayed attempt must NOT redo, or the
  // same event lands in the digest twice.
  const opened = await step.run(`digest:${channel.name}`, async () => {
    const owned: string[] = [];
    let endsAt = 0;
    for (const recipient of allowed) {
      const bucket = await digest.append({
        slot: slotFor(recipient.id),
        event,
        windowMs,
        now: ctx.now(),
      });
      if (!bucket.opened) continue;
      owned.push(recipient.id);
      endsAt = Math.max(endsAt, bucket.endsAt);
    }
    return { owned, endsAt };
  });

  tally.digested += allowed.length - opened.owned.length;
  if (opened.owned.length === 0) return;

  const remaining = opened.endsAt - ctx.now().getTime();
  if (remaining > 0) await step.sleep(`digest-wait:${channel.name}`, remaining);

  const byId = new Map(allowed.map((recipient) => [recipient.id, recipient]));
  for (const id of opened.owned) {
    const recipient = byId.get(id);
    if (recipient === undefined) continue;
    // Drain and send are TWO steps on purpose. The drain's result is checkpointed, so an ordinary
    // retry of the send replays the batch from the step store rather than from a window that is
    // now empty. What it does not close is a process killed between the drain and its checkpoint;
    // `DigestStore.drain` says so in its own words, and a durable store can do better.
    const batch = await step.run(`digest-drain:${channel.name}:${id}`, () =>
      digest.drain(slotFor(id)),
    );
    if (batch.length === 0) continue;
    const events = rehydrate<Params>(batch);
    const newest = events[events.length - 1] ?? event;
    const sent = await step.run(`digest-send:${channel.name}:${id}`, (signal) =>
      attemptDelivery(
        {
          ledger: notifyStores().ledger,
          // The window, not the event: a digest is one delivery for many events, so its ledger
          // identity is the slot plus the window it closed. Two different windows for the same
          // recipient are two deliveries and must not dedupe into one.
          claim: {
            notifier: plan.name,
            key: `digest:${group}:${String(opened.endsAt)}`,
            recipient: id,
            channel: channel.name,
          },
          notifier: plan.name,
          channel: channel.name,
          recipients: 1,
          ctx,
          send: (abort) =>
            channel.deliver({ ctx, recipient, event: newest, batch: events, signal: abort }),
        },
        signal,
      ),
    );
    if (sent) tally.delivered += 1;
    else tally.replayed += 1;
  }
}

/**
 * A step's return value round-trips through JSON, so a replayed batch arrives with `at` as an ISO
 * string that the type still calls a `Date`. Rebuilt here rather than trusted — a channel that
 * formats it would throw on `at.getTime` only on the replay path, which is the path nothing tests.
 *
 * The cast is the digest store's untyped edge: it holds `NotifyEvent<unknown>` because one store
 * serves every notifier, and what comes out of a slot is exactly what this notifier put in.
 */
const rehydrate = <Params>(
  batch: readonly NotifyEvent<unknown>[],
): readonly NotifyEvent<Params>[] =>
  batch.map((entry) => ({ ...entry, at: new Date(entry.at) })) as readonly NotifyEvent<Params>[];
