// The `SmsTransport` contract of `@ultimat3/notify` as shared examples, for a provider adapter of
// your own (Twilio, Vonage, SNS): `behavesLike(smsTransportConformance, () => transport)`. Asked
// through `send` alone — what a transport answers about a message, never how its wire looks.

import { expect, test } from 'bun:test';
import type { SmsMessage, SmsTransport } from '@ultimat3/notify/adapter';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface SmsTransportCheck {
  readonly name: string;
  run(transport: SmsTransport): Promise<void>;
}

const TO = '+4915112345678';
const CONCURRENT_SENDS = 8;

/** A rendered message, by hand: the port receives text already in the recipient's language. */
export const conformanceSms = (overrides: Partial<SmsMessage> = {}): SmsMessage => ({
  to: TO,
  body: 'Your code is 424242',
  idempotencyKey: 'conformance-sms-1',
  ...overrides,
});

const refusedCode = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return expect.unreachable('expected the transport to refuse');
};

export const SMS_TRANSPORT_CHECKS: readonly SmsTransportCheck[] = [
  {
    name: 'a send resolves a result naming this transport and the number it accepted',
    async run(transport) {
      expect(transport.name.length).toBeGreaterThan(0);
      const result = await transport.send(conformanceSms());
      expect([result.transport, result.to]).toEqual([transport.name, TO]);
      expect(result.id.length).toBeGreaterThan(0);
    },
  },
  {
    // A caller matching a retry to its first send reads this key back.
    name: 'the idempotency key is answered back unchanged, the same on every attempt',
    async run(transport) {
      const message = conformanceSms();
      const first = await transport.send(message);
      const second = await transport.send(message);
      expect([first.idempotencyKey, second.idempotencyKey]).toEqual([
        message.idempotencyKey,
        message.idempotencyKey,
      ]);
    },
  },
  {
    // The id lands in logs and the delivery ledger; the number and the body are a person's.
    name: 'the result id carries neither the number nor the body',
    async run(transport) {
      const message = conformanceSms();
      const result = await transport.send(message);
      for (const leak of [TO, TO.slice(1), message.body]) expect(result.id).not.toContain(leak);
    },
  },
  {
    // A local spelling is a number the provider guesses the country of: a message to a stranger.
    name: 'a number that is not E.164 is refused with X_NOTIFY_SMS_NUMBER_INVALID',
    async run(transport) {
      for (const to of ['015112345678', '+49 151 12345678', '']) {
        expect(await refusedCode(() => transport.send(conformanceSms({ to })))).toBe(
          'X_NOTIFY_SMS_NUMBER_INVALID',
        );
      }
    },
  },
  {
    name: `${CONCURRENT_SENDS} concurrent sends each answer for their own message`,
    async run(transport) {
      const messages = Array.from({ length: CONCURRENT_SENDS }, (_, index) =>
        conformanceSms({
          to: `+1415555${String(index).padStart(4, '0')}`,
          idempotencyKey: `conformance-sms-${String(index)}`,
        }),
      );
      const results = await Promise.all(messages.map((message) => transport.send(message)));
      expect(results.map((result) => [result.to, result.idempotencyKey])).toEqual(
        messages.map((message) => [message.to, message.idempotencyKey]),
      );
    },
  },
];

export const smsTransportConformance: SharedExamples<SmsTransport | Promise<SmsTransport>> =
  sharedExamples('an SMS transport', (subject) => {
    for (const check of SMS_TRANSPORT_CHECKS) {
      test(check.name, async () => {
        await check.run(await subject());
      });
    }
  });
