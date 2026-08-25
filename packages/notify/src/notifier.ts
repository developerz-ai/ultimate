// `notifier()` — one declaration, many channels, declared as a `job` and NOT as a ninth primitive.
//
// A notification is durable background work with an input schema, an idempotency key, a retry
// policy and a queue, which is the definition of a `job` — so this file is a FACTORY over `job()`,
// exactly as `llm()` is one over `action()` and `backfill()` is one over `job()`. That is what
// gives a notifier `.enqueue()`, the worker's cancellation, the dead-letter path, `x jobs show` and
// a manifest row without a line here.
//
// The declaration lives here and the fan-out lives in `fanout.ts` — the same split `backfill.ts`
// and `backfill-pass.ts` already have.

import type { JobHandle, JobTenant, RetryPolicy } from '@ultimat3/jobs';
import { DEFAULT_RETRY, job } from '@ultimat3/jobs';
import type { Schema } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import { isBulkChannel } from './channel';
import {
  NotifyChannelDuplicateError,
  NotifyChannelsEmptyError,
  NotifyDigestUnsupportedError,
} from './errors';
import { runFanout } from './fanout';
import type { Recipient } from './notification';
import { recipientSchema } from './notification';
import type {
  ChannelDelivery,
  NotifyDuration,
  NotifyPayload,
  NotifyPlan,
  RecipientArgs,
  ResolvedDelivery,
} from './plan';
import { toDurationMs } from './plan';

/**
 * One run is one queue row and one step trace, and every recipient in it is a durable step row. The
 * ceiling is a real number rather than a shrug: past it the shape is a bulk channel or a paged
 * sweep, and `X_NOTIFY_FANOUT_TOO_WIDE` says so with both numbers in it.
 */
export const DEFAULT_MAX_RECIPIENTS = 500;

/**
 * `NoInfer` on every field but `input`, deliberately. Without it `Params` is inferred from all six
 * at once and `deliver: [inAppChannel()]` — whose own default is `unknown` — wins, so an author
 * who did not write `notifier<Params>(…)` got `params` typed `unknown` in `key`, `tenant`,
 * `recipients` and every gate. The schema is the ONE declaration of what the params are, which is
 * the same rule every other primitive in this framework follows; this makes the inference agree.
 */
export interface NotifierDefinition<Params> {
  /**
   * REQUIRED, unlike a job's. A notifier's name is a durable key — the queue row, the delivery
   * ledger, every inbox row and the app's preference taxonomy all carry it — so it is never left
   * to whichever export name a module happened to use.
   */
  readonly name: string;
  /** The params, as a schema and not a `required_params` list: validated once at the boundary,
   * which is also what gives the notifier a manifest row and a typed client. */
  readonly input: Schema<unknown, Params>;
  /** REQUIRED, exactly as on `job()`. A notifier IS a job and declares the org it runs under. */
  readonly tenant: JobTenant<NoInfer<Params>>;
  /**
   * What makes two invocations the SAME notification, for the queue AND for the delivery ledger.
   * Required for the reason `job().idempotencyKey` is: queues deliver at least once, so "did this
   * already go out?" is a question every notifier must be able to answer.
   */
  readonly key: (params: NoInfer<Params>) => string;
  /**
   * The audience, resolved on the worker inside a durable step. Omit it and every enqueue must
   * name its own recipients — `noticed`'s two modes, and both are here because both are real: a
   * "post liked" notifier derives its audience, and an admin broadcast is handed one.
   */
  readonly recipients?:
    | ((
        args: RecipientArgs<NoInfer<Params>>,
      ) => Promise<readonly Recipient[]> | readonly Recipient[])
    | undefined;
  /** At least one. Order does not matter — the fan-out sorts by `wait`. */
  readonly deliver: readonly ChannelDelivery<NoInfer<Params>>[];
  readonly queue?: string | undefined;
  readonly retry?: RetryPolicy | undefined;
  readonly timeout?: NotifyDuration | undefined;
  /** Defaults to `DEFAULT_MAX_RECIPIENTS`. */
  readonly maxRecipients?: number | undefined;
}

/** Normalised once, at declaration: the run body never re-parses a duration per recipient. */
function resolve<Params>(
  name: string,
  deliveries: readonly ChannelDelivery<Params>[],
): readonly ResolvedDelivery<Params>[] {
  if (deliveries.length === 0) throw new NotifyChannelsEmptyError({ notifier: name });
  const seen = new Set<string>();
  const resolved = deliveries.map((delivery): ResolvedDelivery<Params> => {
    const channel = delivery.channel;
    if (seen.has(channel.name)) {
      throw new NotifyChannelDuplicateError({ notifier: name, channel: channel.name });
    }
    seen.add(channel.name);
    if (delivery.digest !== undefined && isBulkChannel(channel)) {
      throw new NotifyDigestUnsupportedError({ notifier: name, channel: channel.name });
    }
    return {
      channel,
      waitMs: delivery.wait === undefined ? 0 : toDurationMs(delivery.wait),
      when: delivery.if,
      unless: delivery.unless,
      digestMs: delivery.digest === undefined ? undefined : toDurationMs(delivery.digest.window),
      group: delivery.digest?.group,
    };
  });
  // Ascending, so the fan-out sleeps the delta between one channel and the next. A stable sort
  // keeps two channels with the same wait in declaration order, which is the order their step
  // names appear in a trace.
  return [...resolved].sort((a, b) => a.waitMs - b.waitMs);
}

export function notifier<Params>(
  definition: NotifierDefinition<Params>,
): JobHandle<NotifyPayload<Params>> {
  const deliveries = resolve(definition.name, definition.deliver);
  const declared = definition.recipients;
  const plan: NotifyPlan<Params> = {
    name: definition.name,
    maxRecipients: definition.maxRecipients ?? DEFAULT_MAX_RECIPIENTS,
    deliveries,
    keyFor: (params) => definition.key(params),
    // Bound to the definition rather than torn off it, so an author who writes `recipients` as a
    // method rather than an arrow still gets the right `this`. An enqueue that names no audience
    // and a notifier that resolves none is an empty fan-out, not an error: a broadcast with no
    // subscribers left is a legitimate run that delivers nothing.
    recipientsFor: (args) => (declared === undefined ? [] : declared.call(definition, args)),
  };

  // Nested rather than spread into the job's input: an app's params may legitimately carry a field
  // called `recipients`, and a reserved top-level key would collide with the first notification
  // that is *about* recipients.
  const payload = t.object({
    params: definition.input,
    recipients: t.array(recipientSchema).optional(),
  }) as unknown as Schema<unknown, NotifyPayload<Params>>;

  return job<NotifyPayload<Params>>({
    name: definition.name,
    input: payload,
    // The declared key verbatim. One value for the queue's dedupe and the ledger's event column,
    // because they ask one question — a second spelling would be two answers that can disagree.
    idempotencyKey: (value) => definition.key(value.params),
    // Forwarded, never decided here: a notifier that declared its tenant and then ran under
    // somebody else's would be a factory deciding authz.
    tenant:
      typeof definition.tenant === 'function'
        ? (value: NotifyPayload<Params>) =>
            (definition.tenant as (params: Params) => string)(value.params)
        : definition.tenant,
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    run: (args) => runFanout(plan, args),
  });
}
