// SMS as a channel, over the `smsTransport` port: per recipient, its E.164 number, the message as a
// catalog KEY rendered in the recipient's locale, one idempotency key per delivery. The provider is
// the app's adapter (`smsTransport:` in `apps/<app>/runtime.ts`); this is the reference channel.
//
//   smsChannel<LoginCode>({ message: ({ event }) => ({ key: 'sms.login_code', params: { code: event.params.code } }) })

import { currentLocale, translatorFor } from '@ultimat3/i18n';
import type { DeliveryArgs, NotifyChannel } from './channel';
import { deliveryChannel } from './channel';
import type { Recipient } from './notification';
import type { PushTranslate } from './push-message';
import type { SmsTransport } from './sms-transport';
import { assertSmsNumber, smsTransport } from './sms-transport';

export const SMS_CHANNEL = 'sms';

/** What one SMS says, as a catalog key and its params — never text (`t()`, house rule). */
export interface NotifySmsMessage {
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>> | undefined;
}

export interface SmsChannelOptions<Params> {
  readonly message: (args: DeliveryArgs<Params>) => NotifySmsMessage;
  /**
   * Where the number comes from. Defaults to `recipient.to`. `undefined` back is a recipient with
   * no phone — settled as sent and logged `notify.address_missing`, as `mailChannel` does.
   */
  readonly numberOf?: ((recipient: Recipient) => string | undefined) | undefined;
  readonly name?: string | undefined;
  /** Defaults to the installed `smsTransport()`, read per delivery. A test may hand one in. */
  readonly transport?: SmsTransport | undefined;
  /** Defaults to `translatorFor(locale)`. The recipient's locale, else the app's fallback. */
  readonly translate?: ((locale: string) => PushTranslate) | undefined;
}

/**
 * The key a provider dedupes on: the same for every attempt of one (notification, channel,
 * recipient) — the delivery ledger's own key — and holding no number.
 */
export const smsIdempotencyKey = (
  notifier: string,
  eventKey: string,
  channel: string,
  recipient: string,
): string => JSON.stringify([notifier, eventKey, channel, recipient]);

export function smsChannel<Params = unknown>(
  options: SmsChannelOptions<Params>,
): NotifyChannel<Params> {
  const name = options.name ?? SMS_CHANNEL;
  const numberOf = options.numberOf ?? ((recipient: Recipient) => recipient.to);
  const translate = options.translate ?? ((locale: string) => translatorFor(locale));
  return deliveryChannel<Params>(name, async (args) => {
    const { recipient, event, ctx, signal } = args;
    const to = numberOf(recipient);
    if (to === undefined || to === '') {
      ctx.logger.warn('notify.address_missing', { recipient: recipient.id, channel: name });
      return;
    }
    // Refused before rendering or sending: a number that is wrong now is wrong on every retry.
    assertSmsNumber(to, recipient.id);
    const message = options.message(args);
    const body = translate(recipient.locale ?? currentLocale())(message.key, message.params);
    await (options.transport ?? smsTransport()).send({
      to,
      body,
      idempotencyKey: smsIdempotencyKey(event.notifier, event.key, name, recipient.id),
      signal,
    });
  });
}
