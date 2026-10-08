// Single responsibility: one notification to EVERY device of one person. Renders the payload's
// catalog keys in each subscription's own locale, sends each one, deletes the dead, and reports
// the rest — throwing only when a retry could change the answer.
//
// `webPush()` is the shape `@ultimat3/notify`'s `pushChannel({ pusher })` takes, declared there
// structurally (notify cannot import this package: same tier), so `notify(user, …)` reaches every
// subscription that user holds with no glue in the app.

import { isUltimateError, logger } from '@ultimat3/core';
import type { PushPayload } from './push';
import { renderPushPayload, serializePushMessage, subscriptionState } from './push';
import { webPushRuntime } from './push-runtime';
import type { PushDelivery } from './push-send';
import { sendPushMessage } from './push-send';

/** What a notification says (catalog keys, never text) and how it travels. */
export interface PushNotification extends PushPayload, PushDelivery {}

export interface PushReport {
  readonly delivered: number;
  /** 404/410 or expired — deleted from the store. */
  readonly removed: number;
  /** Refused for good (`X_PWA_PUSH_REJECTED`, a body too large, a malformed key) — logged. */
  readonly refused: number;
}

/**
 * Every subscription of `actorId`, in endpoint order. A refusal that a retry cannot cure is logged
 * with its code and fix and counted; a failure a retry CAN cure (`X_PWA_PUSH_FAILED`) is rethrown
 * AFTER every other device was tried, so one flaky push service does not hold back the rest — and
 * on the retry the devices that did receive it get it again. A notification with a `tag` replaces
 * itself on those devices; one without shows twice, which is why a notifier should always set one.
 */
export async function pushToActor(
  actorId: string,
  notification: PushNotification,
  signal?: AbortSignal,
): Promise<PushReport> {
  const runtime = webPushRuntime('pushToActor');
  const subscriptions = await runtime.store.listFor(actorId);
  let delivered = 0;
  let removed = 0;
  let refused = 0;
  let retry: unknown;
  for (const subscription of subscriptions) {
    if (subscriptionState(subscription, null, runtime.clock) === 'expired') {
      await runtime.store.remove(subscription.endpoint);
      removed += 1;
      continue;
    }
    const rendered = renderPushPayload(
      notification,
      subscription.locale,
      runtime.translate(subscription.locale),
    );
    for (const warning of rendered.warnings) logger.warn('pwa.push.render', { warning });
    try {
      const outcome = await sendPushMessage({
        target: subscription,
        plaintext: new TextEncoder().encode(serializePushMessage(rendered)),
        vapid: runtime.signer,
        delivery: notification,
        fetch: runtime.fetch,
        clock: runtime.clock,
        signal,
      });
      if (outcome.kind === 'gone') {
        await runtime.store.remove(subscription.endpoint);
        removed += 1;
      } else {
        delivered += 1;
      }
    } catch (error) {
      if (isUltimateError(error) && error.code === 'X_PWA_PUSH_FAILED') {
        retry ??= error;
        continue;
      }
      if (!isUltimateError(error)) throw error;
      refused += 1;
      // A stored subscription with a malformed key is one no send will ever reach: deleted, so
      // the next notification does not pay for it again.
      if (error.code === 'X_PWA_PUSH_SUBSCRIPTION_INVALID') {
        await runtime.store.remove(subscription.endpoint);
      }
      logger.error('pwa.push.refused', { code: error.code, cause: error.cause, fix: error.fix });
    }
  }
  if (retry !== undefined) throw retry;
  return { delivered, removed, refused };
}

/** The structural shape `@ultimat3/notify`'s `Pusher` declares. */
export interface WebPusher {
  send(push: {
    readonly to: string;
    readonly message: PushNotification;
    readonly signal: AbortSignal;
  }): Promise<void>;
}

/**
 * The installed runtime as a notify pusher: `pushChannel({ pusher: webPush(), message })`. It
 * reads the runtime per send, so it can be declared at module scope before the boot installs one.
 */
export function webPush(): WebPusher {
  return {
    async send({ to, message, signal }) {
      await pushToActor(to, message, signal);
    },
  };
}
