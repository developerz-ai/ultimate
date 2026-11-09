// The digest branch of the fan-out: append every allowed recipient's event to its window, and let
// whichever run OPENED a window own the flush.
//
// Exactly one run opens a given window, so exactly one sleeps on it — which is what stops fifty
// events in one hour from scheduling fifty flushes of the same digest.

import type { StepOutput } from '@ultimat3/jobs';
import { attemptDelivery } from './attempt';
import type { NotifyChannel } from './channel';
import type { DigestSlot } from './digest';
import type { Walk } from './fanout-walk';
import { chunksOf } from './fanout-walk';
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
  const { plan, event, ctx, runId, step, tally } = walk;
  const windowMs = delivery.digestMs ?? 0;
  const digest = requireDigest(plan.name);
  const group = delivery.group?.(event) ?? plan.name;
  const slotFor = (recipient: string): DigestSlot => ({
    recipient,
    notifier: plan.name,
    channel: channel.name,
    group,
  });

  // ONE STEP PER APPEND, and the step store is the fence: a completed append is never redone, so
  // the same event never lands in a digest twice. NOT chunked (`NOTIFY_CHUNK_SIZE`) for that reason:
  // a chunk step re-runs whole. One step for the whole pass re-ran every append
  // when any one failed, and the window a re-run append had joined may already have been drained
  // and deleted by its owner — nothing in the store remembered it, so the event went out again in
  // a second digest. The appender id is the store's own defence behind the step: an append whose
  // write committed but whose answer was lost, or a run whose step history is gone, gets back the
  // window it already landed in — `opened` included — for as long as that window exists.
  // Each owner's OWN window end: two recipients' windows need not close together, and the drain
  // takes the window it names.
  const opened: { owned: { readonly id: string; readonly endsAt: number }[]; endsAt: number } = {
    owned: [],
    endsAt: 0,
  };
  for (const recipient of allowed) {
    const bucket = await step.run(`digest:${channel.name}:${recipient.id}`, () =>
      digest.append({
        slot: slotFor(recipient.id),
        event,
        windowMs,
        now: ctx.now(),
        appender: `${runId}:${recipient.id}`,
      }),
    );
    if (!bucket.opened) continue;
    opened.owned.push({ id: recipient.id, endsAt: bucket.endsAt });
    opened.endsAt = Math.max(opened.endsAt, bucket.endsAt);
  }

  tally.digested += allowed.length - opened.owned.length;
  if (opened.owned.length === 0) return;

  const remaining = opened.endsAt - ctx.now().getTime();
  if (remaining > 0) await step.sleep(`digest-wait:${channel.name}`, remaining);

  const byId = new Map(allowed.map((recipient) => [recipient.id, recipient]));
  let index = 0;
  for (const chunk of chunksOf(opened.owned)) {
    // Drain stays ONE STEP PER WINDOW: a drain empties its window, and a process killed between a
    // drain and its checkpoint loses that batch (`DigestStore.drain`'s seam). A chunked drain would
    // widen that loss from one batch to five hundred. Its result is checkpointed, so a retry of
    // the send below replays each batch from the step store rather than from an emptied window.
    const drained: {
      readonly recipient: Recipient;
      readonly endsAt: number;
      readonly batch: StepOutput<readonly NotifyEvent<unknown>[]>;
    }[] = [];
    for (const { id, endsAt } of chunk) {
      const recipient = byId.get(id);
      if (recipient === undefined) continue;
      const batch = await step.run(`digest-drain:${channel.name}:${id}`, () =>
        digest.drain(slotFor(id), endsAt),
      );
      if (batch.length > 0) drained.push({ recipient, endsAt, batch });
    }
    // Named by the chunk's place in `opened.owned`, which the append steps' checkpointed answers
    // decide — stable across a replay.
    const name = `digest-send:${channel.name}:chunk-${String(index)}`;
    index += 1;
    if (drained.length === 0) continue;
    // ONE send step per chunk. Safe where a chunked APPEND is not: a re-run send is fenced per
    // recipient by the ledger claim below, so a chunk that failed part-way re-sends nobody it
    // already reached (counted `replayed`), exactly as `deliver:<channel>:chunk-<n>`.
    const counts = await step.run(name, async (signal) => {
      const answer = { delivered: 0, replayed: 0 };
      for (const { recipient, endsAt, batch } of drained) {
        const events = rehydrate(batch, plan.parseParams);
        const newest = events[events.length - 1] ?? event;
        const sent = await attemptDelivery(
          {
            ledger: notifyStores().ledger,
            // The window, not the event: a digest is one delivery for many events, so its ledger
            // identity is the slot plus the window it closed. Two different windows for the same
            // recipient are two deliveries and must not dedupe into one. THIS recipient's end,
            // never the run's maximum: two runs whose maxima coincide would share one key.
            claim: {
              notifier: plan.name,
              key: `digest:${group}:${String(endsAt)}`,
              recipient: recipient.id,
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
        );
        if (sent) answer.delivered += 1;
        else answer.replayed += 1;
      }
      return answer;
    });
    tally.delivered += counts.delivered;
    tally.replayed += counts.replayed;
  }
}

/**
 * A step answers the stored form, so the drained batch holds `at` and any date in `params` as ISO
 * strings on every attempt, and a channel is promised a `Date` and `Params`: both rebuilt here,
 * `params` through the notifier's own `input`, the parse a job's payload gets off the queue.
 */
const rehydrate = <Params>(
  batch: StepOutput<readonly NotifyEvent<unknown>[]>,
  parseParams: (raw: unknown) => Params,
): readonly NotifyEvent<Params>[] =>
  batch.map((entry) => ({
    ...entry,
    at: new Date(entry.at),
    params: parseParams(entry.params),
  }));
