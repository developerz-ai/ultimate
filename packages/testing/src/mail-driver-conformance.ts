// The `MailDriver` contract of `@ultimat3/mail` as shared examples, for a transport of your own:
// `behavesLike(mailDriverConformance, () => driver)`. Asked through `send` alone — what a driver
// answers about a message, never how its wire looks — so a hand-written driver proves itself with
// one line. The subject is called once per test; a driver with no state may be handed back as is.

import { expect, test } from 'bun:test';
import { mailIdempotencyKey } from '@ultimat3/mail';
import type { MailDriver, MailMessage } from '@ultimat3/mail/adapter';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface MailDriverCheck {
  readonly name: string;
  run(driver: MailDriver): Promise<void>;
}

const TO = 'ada@example.test';
const CC = 'grace@example.test';
const BCC = 'ops@example.test';
const CONCURRENT_SENDS = 8;

/** A rendered envelope, by hand: the port receives one already built, whatever built it. */
export const conformanceMail = (overrides: Partial<MailMessage> = {}): MailMessage => ({
  mailId: 'conformance-basic',
  to: [TO],
  subject: 'Hi Ada',
  html: '<p>Your invite is waiting.</p>',
  text: 'Your invite is waiting.',
  locale: 'en',
  tz: 'UTC',
  ...overrides,
});

const sorted = (values: readonly string[]): readonly string[] => [...values].sort();

export const MAIL_DRIVER_CHECKS: readonly MailDriverCheck[] = [
  {
    name: 'a send resolves a result naming this driver, delivered rather than queued',
    async run(driver) {
      expect(driver.name.length).toBeGreaterThan(0);
      const result = await driver.send(conformanceMail());
      expect([result.driver, result.queued]).toEqual([driver.name, false]);
      expect(typeof result.id === 'string' && result.id.length > 0).toBe(true);
    },
  },
  {
    // Bcc is a recipient and never a header: a driver that reports only `to` lost the blind list.
    name: 'accepted is every envelope recipient: to, cc and bcc',
    async run(driver) {
      const result = await driver.send(conformanceMail({ cc: [CC], bcc: [BCC] }));
      expect(sorted(result.accepted)).toEqual(sorted([TO, CC, BCC]));
    },
  },
  {
    // A caller deduping its own retries reads this key; minted per attempt, it dedupes nothing.
    name: 'the idempotency key is the content key, the same on every attempt',
    async run(driver) {
      const message = conformanceMail();
      const first = await driver.send(message);
      const second = await driver.send(message);
      expect([first.idempotencyKey, second.idempotencyKey]).toEqual([
        mailIdempotencyKey(message),
        mailIdempotencyKey(message),
      ]);
    },
  },
  {
    name: 'a different recipient is a different idempotency key',
    async run(driver) {
      const ada = await driver.send(conformanceMail());
      const ben = await driver.send(conformanceMail({ to: ['ben@example.test'] }));
      expect(ben.idempotencyKey).not.toBe(ada.idempotencyKey);
    },
  },
  {
    // The id lands in logs and mail headers every recipient reads; the key holds the recipients.
    name: 'the result id carries no recipient address and never the idempotency key',
    async run(driver) {
      const message = conformanceMail({ bcc: [BCC] });
      const result = await driver.send(message);
      for (const leak of [TO, BCC, mailIdempotencyKey(message)]) {
        expect(result.id).not.toContain(leak);
      }
    },
  },
  {
    name: `${CONCURRENT_SENDS} concurrent sends each answer for their own message`,
    async run(driver) {
      const messages = Array.from({ length: CONCURRENT_SENDS }, (_, index) =>
        conformanceMail({ to: [`reader-${index.toString()}@example.test`] }),
      );
      const results = await Promise.all(messages.map((message) => driver.send(message)));
      expect(results.map((result) => result.accepted)).toEqual(messages.map((m) => m.to));
      expect(results.map((result) => result.idempotencyKey)).toEqual(
        messages.map(mailIdempotencyKey),
      );
    },
  },
];

export const mailDriverConformance: SharedExamples<MailDriver | Promise<MailDriver>> =
  sharedExamples('a mail driver', (subject) => {
    for (const check of MAIL_DRIVER_CHECKS) {
      test(check.name, async () => {
        await check.run(await subject());
      });
    }
  });
