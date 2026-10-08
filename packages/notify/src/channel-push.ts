// Web Push as a channel, over a STRUCTURAL pusher rather than an import of @ultimat3/pwa — the tier
// argument `channel-mail.ts` makes about `@ultimat3/mail`, word for word: `pwa` is tier 4 and so is
// this package. `@ultimat3/pwa`'s `webPush()` satisfies `Pusher` in one call, and reaches EVERY
// device the recipient subscribed, each in its own locale:
//
//   pushChannel<CommentPosted>({
//     pusher: webPush(),
//     message: ({ event }) => ({
//       titleKey: 'push.comment.title',
//       bodyKey: 'push.comment.body',
//       params: { who: event.params.commenter },
//       url: `/posts/${event.params.postId}`,
//       tag: `post:${event.params.postId}`,
//     }),
//   })

import type { DeliveryArgs, NotifyChannel } from './channel';
import { deliveryChannel } from './channel';

/**
 * What one push says, as catalog KEYS — never text. The pusher renders them per subscription, in
 * the locale that browser subscribed with, because the server sending a push has no request to
 * read a language off and a notification in the wrong language is a real bug.
 */
export interface NotifyPushMessage {
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly params?: Readonly<Record<string, string | number>> | undefined;
  /** A PATH on this app, opened by a tap. Another origin opens the app's root instead. */
  readonly url: string;
  /**
   * Collapse key ON THE DEVICE: a newer notification with this tag replaces the older one. Set it —
   * a retried delivery re-sends to the devices that already got it, and a tag is what makes that
   * a replacement rather than a second notification.
   */
  readonly tag?: string | undefined;
  /** Alert again when `tag` replaces one. Dropped, with a warning, without a tag. */
  readonly renotify?: boolean | undefined;
  readonly requireInteraction?: boolean | undefined;
  readonly icon?: string | undefined;
  readonly badge?: string | undefined;
  readonly actions?: readonly { readonly action: string; readonly titleKey: string }[] | undefined;
  /** Seconds the push service holds it for an offline device. Default one day. */
  readonly ttlSeconds?: number | undefined;
  readonly urgency?: 'very-low' | 'low' | 'normal' | 'high' | undefined;
  /** Collapse key AT THE PUSH SERVICE, for a device that is offline. */
  readonly topic?: string | undefined;
}

/** The seam. `@ultimat3/pwa`'s `webPush()` is the framework's; a vendor SDK fits it too. */
export interface Pusher {
  send(push: {
    /** The recipient's id — the actor whose subscriptions receive it. */
    readonly to: string;
    readonly message: NotifyPushMessage;
    readonly signal: AbortSignal;
  }): Promise<void> | void;
}

export const PUSH_CHANNEL = 'push';

export interface PushChannelOptions<Params> {
  readonly pusher: Pusher;
  /**
   * The message for this delivery. `batch` is the whole digest window when the delivery is
   * digested — render a count from `batch.length`, not one push per event.
   */
  readonly message: (args: DeliveryArgs<Params>) => NotifyPushMessage;
  readonly name?: string | undefined;
}

/**
 * One delivery per recipient, to every device they subscribed. A recipient with no subscription is
 * NOT a failure — the pusher sends to nobody and the delivery settles, exactly as `mailChannel`
 * settles an addressless recipient: a retry would find the same empty list.
 */
export function pushChannel<Params = unknown>(
  options: PushChannelOptions<Params>,
): NotifyChannel<Params> {
  return deliveryChannel<Params>(options.name ?? PUSH_CHANNEL, async (args) => {
    await options.pusher.send({
      to: args.recipient.id,
      message: options.message(args),
      signal: args.signal,
    });
  });
}
