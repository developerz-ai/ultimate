// The SES receiver against recorded, real-shaped SNS envelopes signed by a per-run test key: what
// a genuine notification becomes, and that every forgery — a foreign topic, a look-alike
// certificate host, a byte changed in any signed field or in the signature — is refused, coded.

import { beforeAll, describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError, type UltimateError } from '@ultimat3/core';
import {
  CERT_URL,
  SES_BOUNCE,
  SES_COMPLAINT,
  SES_DELIVERY,
  type SnsSigner,
  sesNotification,
  snsBody,
  snsRequest,
  snsSigner,
  TOPIC_ARN,
  toBase64,
} from './delivery-event-fixture';
import type { MailFetch } from './driver-resend';
import { type SesEventReceiverOptions, sesEventReceiver } from './ses-event-receiver';
import type { SnsMessage } from './sns-signature';

let signer: SnsSigner;
beforeAll(async () => {
  signer = await snsSigner();
});

/** One minute after the envelopes' `Timestamp`. */
const clock = frozenClock('2026-10-06T12:01:00.000Z');

function receiver(extra: Partial<SesEventReceiverOptions> = {}) {
  const fetched: string[] = [];
  const instance = sesEventReceiver({
    topicArns: [TOPIC_ARN],
    clock,
    fetchCertificate: async (url) => {
      fetched.push(url);
      return signer.certificatePem;
    },
    ...extra,
  });
  return { instance, fetched };
}

async function refusal(promise: Promise<unknown>): Promise<UltimateError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (isUltimateError(error)) return error;
  return expect.unreachable('expected the receiver to refuse with an UltimateError');
}

const receive = (message: SnsMessage, extra: Partial<SesEventReceiverOptions> = {}) =>
  receiver(extra).instance.receive(snsRequest(snsBody(message)));

describe('sesEventReceiver — authentic notifications', () => {
  test('a Bounce becomes one hard bounce per bounced recipient, joined on the SES MessageId', async () => {
    const outcome = await receive(await sesNotification(signer, SES_BOUNCE));
    if (outcome.type !== 'events') return expect.unreachable('expected events');
    expect(outcome.events.map(({ raw: _raw, ...event }) => event)).toEqual([
      {
        provider: 'ses',
        kind: 'bounced',
        bounce: 'hard',
        messageId: SES_BOUNCE.mail.messageId,
        recipient: 'jane@example.test',
        at: new Date('2026-10-06T11:59:38.237Z'),
        eventId: '22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324',
      },
      {
        provider: 'ses',
        kind: 'bounced',
        bounce: 'hard',
        messageId: SES_BOUNCE.mail.messageId,
        recipient: 'richard@example.test',
        at: new Date('2026-10-06T11:59:38.237Z'),
        eventId: '22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324',
      },
    ]);
    // `raw` is the whole SES payload, every field the event type drops included.
    expect(outcome.events[0]?.raw).toEqual(SES_BOUNCE);
  });

  test.each([
    ['Transient', 'soft'],
    ['Undetermined', 'soft'],
    ['Permanent', 'hard'],
  ])('bounceType %s is a %s bounce', async (bounceType, expected) => {
    const payload = { ...SES_BOUNCE, bounce: { ...SES_BOUNCE.bounce, bounceType } };
    const outcome = await receive(await sesNotification(signer, payload));
    expect(outcome.type === 'events' && outcome.events[0]).toMatchObject({ bounce: expected });
  });

  test('a configuration-set Complaint (eventType) and a Delivery are read', async () => {
    const complaint = await receive(await sesNotification(signer, SES_COMPLAINT));
    expect(complaint.type === 'events' && complaint.events[0]).toMatchObject({
      kind: 'complained',
      recipient: 'ada@example.test',
      messageId: SES_COMPLAINT.mail.messageId,
    });
    const delivery = await receive(await sesNotification(signer, SES_DELIVERY));
    expect(delivery.type === 'events' && delivery.events[0]).toMatchObject({
      kind: 'delivered',
      recipient: 'grace@example.test',
      at: new Date('2026-10-06T11:59:40.000Z'),
    });
  });

  test('SignatureVersion 1 (RSA-SHA1), a Subject, and an X.509 v1 certificate all verify', async () => {
    const message = await signer.sign(
      {
        Type: 'Notification',
        MessageId: 'm-v1',
        TopicArn: TOPIC_ARN,
        Subject: 'Amazon SES Email Event Notification',
        Message: JSON.stringify(SES_DELIVERY),
        Timestamp: '2026-10-06T12:00:00.000Z',
      },
      '1',
    );
    const { instance } = receiver({ fetchCertificate: async () => signer.v1CertificatePem });
    const outcome = await instance.receive(snsRequest(snsBody(message)));
    expect(outcome.type).toBe('events');
  });

  test('an SES type this does not model is authentic and ignored, never an error', async () => {
    const outcome = await receive(
      await sesNotification(signer, {
        notificationType: 'AmazonSnsSubscriptionSucceeded',
        message: 'You have successfully subscribed your Amazon SNS topic.',
      }),
    );
    expect(outcome).toEqual({ type: 'ignored', eventType: 'AmazonSnsSubscriptionSucceeded' });
  });

  test('the certificate is fetched once per URL, not once per message', async () => {
    const { instance, fetched } = receiver();
    for (let index = 0; index < 3; index += 1) {
      await instance.receive(snsRequest(snsBody(await sesNotification(signer, SES_DELIVERY))));
    }
    expect(fetched).toEqual([CERT_URL]);
  });
});

describe('sesEventReceiver — SubscriptionConfirmation', () => {
  const confirmUrl =
    'https://sns.us-west-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:us-west-2:123456789012:ses-events&Token=2336412f37fb687f5d51e6e2425f004aed';
  const confirmation = () =>
    signer.sign({
      Type: 'SubscriptionConfirmation',
      MessageId: '165545c9-2a5c-472c-8df2-7ff2be2b3b1b',
      Token: '2336412f37fb687f5d51e6e2425f004aed',
      TopicArn: TOPIC_ARN,
      Message: `You have chosen to subscribe to the topic ${TOPIC_ARN}.\nTo confirm the subscription, visit the SubscribeURL included in this message.`,
      SubscribeURL: confirmUrl,
      Timestamp: '2026-10-06T12:00:00.000Z',
    });

  test('answers the confirm URL and fetches nothing unless asked', async () => {
    const seen: string[] = [];
    const fetch: MailFetch = async (url) => {
      seen.push(url);
      return new Response('<ConfirmSubscriptionResponse/>');
    };
    expect(await receive(await confirmation(), { fetch })).toEqual({
      type: 'subscription',
      topicArn: TOPIC_ARN,
      confirmUrl,
      confirmed: false,
    });
    expect(seen).toEqual([]);

    const confirmed = await receive(await confirmation(), { fetch, confirmSubscriptions: true });
    expect(confirmed).toMatchObject({ type: 'subscription', confirmed: true });
    expect(seen).toEqual([confirmUrl]);
  });

  test('a failed confirm GET is a 503-class refusal SNS will redeliver', async () => {
    const fetch: MailFetch = async () => new Response('', { status: 500 });
    const error = await refusal(
      receive(await confirmation(), { fetch, confirmSubscriptions: true }),
    );
    expect(error.code).toBe('X_MAIL_EVENT_PROVIDER_UNREACHABLE');
  });

  test('a signed SubscribeURL off the pinned host is never fetched', async () => {
    const message = await signer.sign({
      Type: 'SubscriptionConfirmation',
      MessageId: 'm-sub',
      Token: 't',
      TopicArn: TOPIC_ARN,
      Message: 'confirm',
      SubscribeURL: 'https://evil.test/?Action=ConfirmSubscription',
      Timestamp: '2026-10-06T12:00:00.000Z',
    });
    const fetch: MailFetch = () => expect.unreachable('the confirm URL must not be fetched');
    const error = await refusal(receive(message, { fetch, confirmSubscriptions: true }));
    expect(error.code).toBe('X_MAIL_EVENT_INVALID');
  });
});

describe('sesEventReceiver — forgeries are refused', () => {
  test('a topic this app does not own is refused before any certificate is fetched', async () => {
    const { instance, fetched } = receiver({
      topicArns: ['arn:aws:sns:us-west-2:123456789012:other-topic'],
    });
    const error = await refusal(
      instance.receive(snsRequest(snsBody(await sesNotification(signer, SES_BOUNCE)))),
    );
    expect(error.code).toBe('X_MAIL_EVENT_UNVERIFIED');
    expect(error.meta).toEqual({ provider: 'ses', reason: 'topic' });
    expect(fetched).toEqual([]);
  });

  test.each([
    ['http://sns.us-west-2.amazonaws.com/SimpleNotificationService-x.pem'],
    ['https://sns.us-west-2.amazonaws.com.evil.test/SimpleNotificationService-x.pem'],
    ['https://evil.test/sns.us-west-2.amazonaws.com/SimpleNotificationService-x.pem'],
    ['https://sns.us-east-1.amazonaws.com/SimpleNotificationService-x.pem'],
    ['https://sns.us-west-2.amazonaws.com:8443/SimpleNotificationService-x.pem'],
    ['https://user@sns.us-west-2.amazonaws.com/SimpleNotificationService-x.pem'],
    ['https://sns.us-west-2.amazonaws.com/SimpleNotificationService-x.txt'],
    ['https://sns.us-west-2.amazonaws.com/x.pem?redirect=https://evil.test'],
  ])('certificate URL %s is refused and never fetched', async (url) => {
    const signed = await sesNotification(signer, SES_BOUNCE);
    const { instance, fetched } = receiver();
    const error = await refusal(
      instance.receive(snsRequest(snsBody({ ...signed, SigningCertURL: url }))),
    );
    expect(error.meta).toEqual({ provider: 'ses', reason: 'certificate-url' });
    expect(fetched).toEqual([]);
  });

  test('a message with no signature fields is unsigned', async () => {
    const {
      Signature: _s,
      SigningCertURL: _c,
      SignatureVersion: _v,
      ...bare
    } = await sesNotification(signer, SES_BOUNCE);
    const error = await refusal(receiver().instance.receive(snsRequest(JSON.stringify(bare))));
    expect(error.meta).toEqual({ provider: 'ses', reason: 'unsigned' });
  });

  test('SignatureVersion 3 is refused', async () => {
    const signed = await sesNotification(signer, SES_BOUNCE);
    const error = await refusal(receive({ ...signed, SignatureVersion: '3' }));
    expect(error.meta).toEqual({ provider: 'ses', reason: 'signature-version' });
  });

  test('a certificate whose key did not sign it is refused', async () => {
    const other = await snsSigner();
    const error = await refusal(
      receive(await sesNotification(signer, SES_BOUNCE), {
        fetchCertificate: async () => other.certificatePem,
      }),
    );
    expect(error.meta).toEqual({ provider: 'ses', reason: 'signature' });
  });

  test('a signature over SHA-1 does not pass as SignatureVersion 2', async () => {
    const signed = await sesNotification(signer, SES_BOUNCE);
    const { Signature: _s, ...unsigned } = signed;
    const sha1 = await signer.signatureOf({ ...unsigned, SignatureVersion: '1' });
    const error = await refusal(receive({ ...signed, Signature: toBase64(sha1) }));
    expect(error.meta).toEqual({ provider: 'ses', reason: 'signature' });
  });

  // Every character of every SIGNED value. SNS signs fields, not bytes: re-ordering keys or
  // changing the unsigned UnsubscribeURL is not a forgery, and the AWS procedure accepts it.
  test.each([['Message'], ['MessageId'], ['Timestamp'], ['TopicArn'], ['Subject']] as const)(
    'changing any one character of %s is refused',
    async (field) => {
      const signed = await signer.sign({
        Type: 'Notification',
        MessageId: '22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324',
        TopicArn: TOPIC_ARN,
        Subject: 'Amazon SES Email Event Notification',
        Message: JSON.stringify(SES_COMPLAINT),
        Timestamp: '2026-10-06T12:00:00.000Z',
      });
      const value = signed[field] ?? '';
      // The topic is checked against the allow-list first, so a changed ARN is refused as a topic.
      const { instance } = receiver({ topicArns: [TOPIC_ARN] });
      for (let index = 0; index < value.length; index += 1) {
        const swapped = value[index] === 'a' ? 'b' : 'a';
        const tampered = `${value.slice(0, index)}${swapped}${value.slice(index + 1)}`;
        const error = await refusal(
          instance.receive(snsRequest(snsBody({ ...signed, [field]: tampered }))),
        );
        expect(error.code).toBe('X_MAIL_EVENT_UNVERIFIED');
        expect(error.meta?.['reason']).toBe(field === 'TopicArn' ? 'topic' : 'signature');
      }
    },
  );

  test('flipping any one byte of the signature is refused', async () => {
    const signed = await sesNotification(signer, SES_COMPLAINT);
    const bytes = Uint8Array.from(atob(signed.Signature), (char) => char.charCodeAt(0));
    const { instance } = receiver();
    for (let index = 0; index < bytes.length; index += 1) {
      const flipped = bytes.slice();
      flipped[index] = (flipped[index] ?? 0) ^ 0x01;
      const error = await refusal(
        instance.receive(snsRequest(snsBody({ ...signed, Signature: toBase64(flipped) }))),
      );
      expect(error.meta).toEqual({ provider: 'ses', reason: 'signature' });
    }
  });

  test('an authentic message outside the window is stale, not invalid', async () => {
    const signed = await sesNotification(signer, SES_BOUNCE);
    const error = await refusal(receive(signed, { clock: frozenClock('2026-10-06T14:00:01Z') }));
    expect(error.meta).toEqual({ provider: 'ses', reason: 'stale' });
  });
});

describe('sesEventReceiver — bodies and configuration', () => {
  test.each([
    ['not json', 'not-json'],
    ['{"Type":"Notification"}', 'envelope'],
  ])('body %p is X_MAIL_EVENT_INVALID (%s)', async (body, problem) => {
    const error = await refusal(receiver().instance.receive(snsRequest(body)));
    expect(error.code).toBe('X_MAIL_EVENT_INVALID');
    expect(error.meta).toEqual({ provider: 'ses', problem });
  });

  test('a body over maxBytes is refused without being held', async () => {
    const { instance } = receiver({ maxBytes: 64 });
    const error = await refusal(instance.receive(snsRequest('x'.repeat(65))));
    expect(error.meta).toEqual({ provider: 'ses', problem: 'too-large' });
  });

  test('a certificate download that fails is 503-class, so SNS redelivers', async () => {
    const error = await refusal(
      receive(await sesNotification(signer, SES_BOUNCE), {
        fetchCertificate: () => Promise.reject(new TypeError('getaddrinfo ENOTFOUND')),
      }),
    );
    expect(error.code).toBe('X_MAIL_EVENT_PROVIDER_UNREACHABLE');
    expect(error.cause).toContain('ENOTFOUND');
  });

  test('the default download refuses a redirect and is pinned to the fetch it was given', async () => {
    const seen: RequestInit[] = [];
    const fetch: MailFetch = async (_url, init) => {
      seen.push(init);
      return new Response(signer.certificatePem);
    };
    const instance = sesEventReceiver({ topicArns: [TOPIC_ARN], clock, fetch });
    await instance.receive(snsRequest(snsBody(await sesNotification(signer, SES_BOUNCE))));
    expect(seen[0]?.redirect).toBe('error');
  });

  test.each([[[]], [['not-an-arn']]])('topicArns %p is refused at construction', (topicArns) => {
    expect(() => sesEventReceiver({ topicArns })).toThrow(/topic ARN/);
  });
});

describe('sesEventReceiver — prototype keys from the body', () => {
  test.each([['constructor'], ['__proto__'], ['toString']])(
    'a signed notificationType of %p is ignored',
    async (notificationType) => {
      const outcome = await receive(
        await sesNotification(signer, { ...SES_BOUNCE, notificationType }),
      );
      expect(outcome).toEqual({ type: 'ignored', eventType: notificationType });
    },
  );

  test.each([['constructor'], ['__proto__'], ['toString']])(
    'a bounceType of %p is a soft bounce',
    async (bounceType) => {
      const payload = { ...SES_BOUNCE, bounce: { ...SES_BOUNCE.bounce, bounceType } };
      const outcome = await receive(await sesNotification(signer, payload));
      expect(outcome.type === 'events' && outcome.events[0]).toMatchObject({ bounce: 'soft' });
    },
  );

  test.each([['constructor'], ['__proto__'], ['toString']])(
    'SignatureVersion %p is refused as an unknown version',
    async (version) => {
      const signed = await sesNotification(signer, SES_BOUNCE);
      const error = await refusal(receive({ ...signed, SignatureVersion: version }));
      expect(error.meta).toEqual({ provider: 'ses', reason: 'signature-version' });
    },
  );

  test.each([['constructor'], ['__proto__']])('envelope Type %p is invalid', async (type) => {
    const signed = await sesNotification(signer, SES_BOUNCE);
    const body = JSON.stringify({ ...signed, Type: type });
    const error = await refusal(receiver().instance.receive(snsRequest(body)));
    expect(error.code).toBe('X_MAIL_EVENT_INVALID');
  });
});
