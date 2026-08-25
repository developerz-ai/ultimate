// The run body every notifier's job executes: resolve the audience once, then walk the channels in
// wait order, gating and delivering each.
//
// ONE job for the whole fan-out, where `noticed` enqueues a job per (recipient × channel). The
// reason is `step`: a step IS the retry unit here, so a provider blip on recipient 40 of 50 re-sends
// recipient 40 and replays the other 39 from the step store in microseconds — the same guarantee a
// job-per-recipient buys, without N queue rows, N idempotency keys and N manifest entries.

import type { JobRunArgs } from '@ultimat3/jobs';
import { attemptDelivery } from './attempt';
import type { NotifyChannel } from './channel';
import { isBulkChannel } from './channel';
import { NotifyFanoutTooWideError } from './errors';
import { flushDigest } from './fanout-digest';
import type { Tally, Walk } from './fanout-walk';
import { countSend } from './fanout-walk';
import type { NotifyEvent, Recipient } from './notification';
import type { NotifyPayload, NotifyPlan, NotifyReport, ResolvedDelivery } from './plan';
import { notifyStores } from './stores';

export async function runFanout<Params>(
  plan: NotifyPlan<Params>,
  args: JobRunArgs<NotifyPayload<Params>>,
): Promise<NotifyReport> {
  const { input, step, ctx } = args;
  // One step for BOTH facts, because both must survive a replay: a re-resolved audience would
  // deliver to whoever subscribed during the wait, and a re-read clock would write a different
  // `at` into the inbox on every attempt. Epoch ms rather than a `Date` — a step's return value
  // round-trips through JSON, and a `Date` comes back a string.
  const open = await step.run('open', async () => ({
    at: ctx.now().getTime(),
    recipients: input.recipients ?? [...(await plan.recipientsFor({ input: input.params, ctx }))],
  }));
  const audience = open.recipients;
  if (audience.length > plan.maxRecipients) {
    throw new NotifyFanoutTooWideError({
      notifier: plan.name,
      recipients: audience.length,
      max: plan.maxRecipients,
    });
  }

  const event: NotifyEvent<Params> = {
    notifier: plan.name,
    key: plan.keyFor(input.params),
    params: input.params,
    at: new Date(open.at),
  };
  const tally: Tally = { delivered: 0, suppressed: 0, skipped: 0, replayed: 0, digested: 0 };
  const walk: Walk<Params> = { plan, event, audience, ctx, step, tally };

  // `deliveries` is sorted by `waitMs`, so this sleeps the DELTA and never the sum: an in-app
  // channel with no wait fires now even when the email beside it waits an hour.
  let slept = 0;
  for (const delivery of plan.deliveries) {
    if (delivery.waitMs > slept) {
      await step.sleep(`wait:${delivery.channel.name}`, delivery.waitMs - slept);
      slept = delivery.waitMs;
    }
    await deliverOne(walk, delivery);
  }
  return { recipients: audience.length, ...tally };
}

async function deliverOne<Params>(
  walk: Walk<Params>,
  delivery: ResolvedDelivery<Params>,
): Promise<void> {
  const { event, ctx, tally } = walk;
  // AFTER the sleep above, which is `noticed`'s documented order and the half most hand-rolled
  // versions get wrong: a five-minute delay whose condition went false in minute three must send
  // nothing. Evaluating before the wait would decide on a world that no longer exists.
  if (delivery.when !== undefined && !(await delivery.when({ event, ctx }))) {
    tally.skipped += walk.audience.length;
    return;
  }
  if (delivery.unless !== undefined && (await delivery.unless({ event, ctx }))) {
    tally.skipped += walk.audience.length;
    return;
  }

  const allowed = await allowedBy(walk, delivery.channel.name);
  if (allowed.length === 0) return;

  const channel = delivery.channel;
  if (delivery.digestMs !== undefined) {
    // `notifier()` refused a digest on a bulk channel at declaration, so this narrowing cannot
    // fail at run time — it is here because the type system cannot read that refusal.
    if (isBulkChannel(channel)) return;
    await flushDigest({ walk, channel: channel as NotifyChannel<Params>, delivery, allowed });
    return;
  }
  if (isBulkChannel(channel)) {
    const claim = {
      notifier: walk.plan.name,
      key: event.key,
      // ONE row for the audience: a bulk send is one thing, and half of it is not a state this
      // package can represent.
      recipient: null,
      channel: channel.name,
    };
    const sent = await walk.step.run(`deliver:${channel.name}`, (signal) =>
      attemptDelivery(
        {
          ledger: notifyStores().ledger,
          claim,
          notifier: walk.plan.name,
          channel: channel.name,
          recipients: allowed.length,
          ctx,
          send: (abort) =>
            channel.deliver({ ctx, recipients: allowed, event, batch: [event], signal: abort }),
        },
        signal,
      ),
    );
    countSend(tally, sent);
    return;
  }

  for (const recipient of allowed) {
    const claim = {
      notifier: walk.plan.name,
      key: event.key,
      recipient: recipient.id,
      channel: channel.name,
    };
    // The recipient's id names the step because the id survives a replay and a loop index does
    // not — a step name is the replay key (X_STEP_DUPLICATE).
    const sent = await walk.step.run(`deliver:${channel.name}:${recipient.id}`, (signal) =>
      attemptDelivery(
        {
          ledger: notifyStores().ledger,
          claim,
          notifier: walk.plan.name,
          channel: channel.name,
          recipients: 1,
          ctx,
          send: (abort) =>
            channel.deliver({ ctx, recipient, event, batch: [event], signal: abort }),
        },
        signal,
      ),
    );
    countSend(tally, sent);
  }
}

/**
 * The preference gate, per recipient and per channel — deliberately NOT inside a durable step. It
 * is a read, so replaying it costs a query rather than a row, and re-asking on a retry is the more
 * correct answer anyway: somebody who opted out during a five-minute `wait` should not receive the
 * mail the first attempt had already decided to send.
 */
async function allowedBy<Params>(
  walk: Walk<Params>,
  channel: string,
): Promise<readonly Recipient[]> {
  const { preferences } = notifyStores();
  const allowed: Recipient[] = [];
  for (const recipient of walk.audience) {
    const ok = await preferences.allows({
      recipient,
      notifier: walk.plan.name,
      channel,
      event: walk.event,
      ctx: walk.ctx,
    });
    if (ok) allowed.push(recipient);
    else walk.tally.suppressed += 1;
  }
  return allowed;
}
