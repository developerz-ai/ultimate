// Email as a channel, over a STRUCTURAL mailer rather than an import of @ultimat3/mail.
//
// That is the tier argument, and it is the same one `@ultimat3/action`'s `PgExecutor` makes about
// `@ultimat3/db`. `@ultimat3/mail` is tier 4 and so is this package, so importing it would be a
// sideways edge — and moving `notify` to tier 5 to legalise it would put notifications above
// `render`, `pwa` and `ui` for no reason other than one channel's transport. A mailer is a driver
// seam, so it is declared here as the shape it is: one method, no dependency.
//
//   mailChannel({ mailer: { send: (mail) => send(postLiked, mail.batch[0].params, {
//     to: mail.to, locale: mail.locale ?? 'en',
//   }) } })

import type { NotifyChannel } from './channel';
import { channel } from './channel';
import type { NotifyEvent, Recipient } from './notification';

/** What a mailer is handed. Everything a template needs to render, and nothing about transport. */
export interface NotifyMail<Params = unknown> {
  readonly to: string;
  /** BCP-47, from the recipient. `undefined` when the app did not resolve one — never guessed. */
  readonly locale: string | undefined;
  /** IANA zone, from the recipient. A mail that formats a date and reads this `undefined` must
   * refuse rather than fall back: no ambient time zone, anywhere. */
  readonly tz: string | undefined;
  /** Oldest first. One entry for an immediate send; the whole window for a digest. */
  readonly batch: readonly NotifyEvent<Params>[];
  readonly signal: AbortSignal;
}

/**
 * The seam. `@ultimat3/mail`'s `send(definition, params, { to, locale })` satisfies it in one
 * line, and so does a transactional-email SDK an app already pays for.
 */
export interface Mailer<Params = unknown> {
  send(mail: NotifyMail<Params>): Promise<void> | void;
}

export const MAIL_CHANNEL = 'email';

export interface MailChannelOptions<Params> {
  readonly mailer: Mailer<Params>;
  readonly name?: string | undefined;
  /**
   * Where the address comes from. Defaults to `recipient.to`.
   *
   * `undefined` back means this recipient has no address, which is NOT a failure: the delivery is
   * settled as sent and logged as `notify.address_missing`, because retrying the same event will
   * find the same missing address and the only outcome of pretending otherwise is a dead letter
   * per addressless recipient.
   */
  readonly addressOf?: ((recipient: Recipient) => string | undefined) | undefined;
}

export function mailChannel<Params = unknown>(
  options: MailChannelOptions<Params>,
): NotifyChannel<Params> {
  const addressOf = options.addressOf ?? ((recipient: Recipient) => recipient.to);
  return channel<Params>(
    options.name ?? MAIL_CHANNEL,
    async ({ recipient, batch, ctx, signal }) => {
      const to = addressOf(recipient);
      if (to === undefined || to === '') {
        ctx.logger.warn('notify.address_missing', { recipient: recipient.id });
        return;
      }
      await options.mailer.send({
        to,
        locale: recipient.locale,
        tz: recipient.tz,
        batch,
        signal,
      });
    },
  );
}
