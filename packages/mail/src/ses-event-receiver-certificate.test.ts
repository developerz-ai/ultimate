// The SES receiver's certificate downloads under attack: every alias of a pinned URL refused
// before a fetch, one download per URL however many messages name it, failures remembered for
// their TTL, and a flood of valid-looking paths held to the in-flight cap without evicting the
// certificate in use. Split from `ses-event-receiver.test.ts` by subject.

import { beforeAll, describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError, type UltimateError } from '@ultimat3/core';
import {
  CERT_URL,
  SES_BOUNCE,
  SES_DELIVERY,
  type SnsSigner,
  sesNotification,
  snsBody,
  snsRequest,
  snsSigner,
  TOPIC_ARN,
} from './delivery-event-fixture';
import { createSesEventReceiver } from './ses-event-receiver';

let signer: SnsSigner;
beforeAll(async () => {
  signer = await snsSigner();
});

/** One minute after the envelopes' `Timestamp`. */
const clock = frozenClock('2026-10-06T12:01:00.000Z');

/** The input a failing download throws — built once, so no test states its verdict with it. */
const notFound = new TypeError('HTTP 404');

function receiver() {
  const fetched: string[] = [];
  const instance = createSesEventReceiver({
    topicArns: [TOPIC_ARN],
    clock,
    fetchCertificate: async (url) => {
      fetched.push(url);
      return signer.certificatePem;
    },
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

describe('createSesEventReceiver — one certificate fetch per pinned URL', () => {
  test('50 aliases of the pinned URL are refused and force no fetch', async () => {
    const signed = await sesNotification(signer, SES_BOUNCE);
    const { instance, fetched } = receiver();
    const path = new URL(CERT_URL).pathname;
    const aliases = [
      ...Array.from({ length: 40 }, (_, index) => `${CERT_URL}#${index}`),
      `${CERT_URL}?`,
      `${CERT_URL}?x=1`,
      `https://sns.us-west-2.amazonaws.com:443${path}`,
      `https://SNS.us-west-2.amazonaws.com${path}`,
      `https://sns.US-WEST-2.amazonaws.com${path}`,
      `https://sns.us-west-2.amazonaws.com${path.replace('/', '\\')}`,
      `https://sns.us-west-2.amazonaws.com。${path}`,
      `https://sns.us-west-2.amazonaws.com.${path}`,
      `https://sns.us-west-2.amazonaws.com/./${path.slice(1)}`,
      `https://sns.us-west-2.amazonaws.com/SimpleNotificationService-F3EC.pem`,
    ];
    expect(aliases).toHaveLength(50);
    for (const url of aliases) {
      const error = await refusal(
        instance.receive(snsRequest(snsBody({ ...signed, SigningCertURL: url }))),
      );
      expect(error.meta).toEqual({ provider: 'ses', reason: 'certificate-url' });
    }
    expect(fetched).toEqual([]);
  });

  test('concurrent messages naming one URL share one download', async () => {
    const message = await sesNotification(signer, SES_DELIVERY);
    let calls = 0;
    const instance = createSesEventReceiver({
      topicArns: [TOPIC_ARN],
      clock,
      fetchCertificate: async () => {
        calls += 1;
        await Bun.sleep(5);
        return signer.certificatePem;
      },
    });
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => instance.receive(snsRequest(snsBody(message)))),
    );
    expect(outcomes.every((outcome) => outcome.type === 'events')).toBe(true);
    expect(calls).toBe(1);
  });

  test('a failed URL is not fetched again within five minutes, and is after', async () => {
    const message = await sesNotification(signer, SES_DELIVERY);
    const clock = frozenClock('2026-10-06T12:01:00.000Z');
    let calls = 0;
    const instance = createSesEventReceiver({
      topicArns: [TOPIC_ARN],
      clock,
      fetchCertificate: async () => {
        calls += 1;
        if (calls === 1) throw notFound;
        return signer.certificatePem;
      },
    });
    expect((await refusal(instance.receive(snsRequest(snsBody(message))))).code).toBe(
      'X_MAIL_EVENT_PROVIDER_UNREACHABLE',
    );
    clock.advance(299_000);
    expect((await refusal(instance.receive(snsRequest(snsBody(message))))).cause).toContain(
      'failed to download moments ago',
    );
    expect(calls).toBe(1);
    clock.advance(2_000);
    expect((await instance.receive(snsRequest(snsBody(message)))).type).toBe('events');
    expect(calls).toBe(2);
  });
});

describe('createSesEventReceiver — a flood of valid-looking certificate URLs', () => {
  const hexPath = (index: number): string =>
    `https://sns.us-west-2.amazonaws.com/SimpleNotificationService-${index.toString(16).padStart(32, '0')}.pem`;

  function flooded() {
    const fetched: string[] = [];
    const instance = createSesEventReceiver({
      topicArns: [TOPIC_ARN],
      clock,
      fetchCertificate: async (url) => {
        fetched.push(url);
        await Bun.sleep(2);
        if (url === CERT_URL) return signer.certificatePem;
        throw notFound;
      },
    });
    return { instance, fetched };
  }

  test('100 concurrent distinct paths cost at most the in-flight cap, and the real cert stays', async () => {
    const { instance, fetched } = flooded();
    const real = await sesNotification(signer, SES_DELIVERY);
    expect((await instance.receive(snsRequest(snsBody(real)))).type).toBe('events');
    const forged = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        refusal(instance.receive(snsRequest(snsBody({ ...real, SigningCertURL: hexPath(index) })))),
      ),
    );
    expect(forged.every((error) => error.code === 'X_MAIL_EVENT_PROVIDER_UNREACHABLE')).toBe(true);
    expect(fetched.length).toBeLessThanOrEqual(1 + 2);
    expect((await instance.receive(snsRequest(snsBody(real)))).type).toBe('events');
    expect(fetched.filter((url) => url === CERT_URL)).toHaveLength(1);
  });

  test('100 sequential distinct paths never evict the verified certificate', async () => {
    const { instance, fetched } = flooded();
    const real = await sesNotification(signer, SES_DELIVERY);
    await instance.receive(snsRequest(snsBody(real)));
    for (let index = 0; index < 100; index += 1) {
      await refusal(
        instance.receive(snsRequest(snsBody({ ...real, SigningCertURL: hexPath(index) }))),
      );
    }
    expect((await instance.receive(snsRequest(snsBody(real)))).type).toBe('events');
    expect(fetched.filter((url) => url === CERT_URL)).toHaveLength(1);
  });

  test('a path that is not 32 lower-case hex is refused before any fetch', async () => {
    const { instance, fetched } = flooded();
    const real = await sesNotification(signer, SES_DELIVERY);
    for (const url of [
      'https://sns.us-west-2.amazonaws.com/SimpleNotificationService-abc.pem',
      `https://sns.us-west-2.amazonaws.com/SimpleNotificationService-${'a'.repeat(33)}.pem`,
      `https://sns.us-west-2.amazonaws.com/SimpleNotificationService-${'A'.repeat(32)}.pem`,
    ]) {
      const error = await refusal(
        instance.receive(snsRequest(snsBody({ ...real, SigningCertURL: url }))),
      );
      expect(error.meta).toEqual({ provider: 'ses', reason: 'certificate-url' });
    }
    expect(fetched).toEqual([]);
  });
});
