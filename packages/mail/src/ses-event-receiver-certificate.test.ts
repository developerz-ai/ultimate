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
import { sesEventReceiver } from './ses-event-receiver';

let signer: SnsSigner;
beforeAll(async () => {
  signer = await snsSigner();
});

/** One minute after the envelopes' `Timestamp`. */
const clock = frozenClock('2026-10-06T12:01:00.000Z');

/** The input a failing download throws — built once, so no test states its verdict with it. */
/** One macrotask: every lookup already issued has run as far as it can go. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/** A download held open until the test says so — "in flight" as a fact, not a delay. */
function gate(): { readonly opened: Promise<void>; open(): void } {
  let open = (): void => undefined;
  const opened = new Promise<void>((done) => (open = done));
  return { opened, open };
}

const notFound = new TypeError('HTTP 404');

function receiver() {
  const fetched: string[] = [];
  const instance = sesEventReceiver({
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

describe('sesEventReceiver — one certificate fetch per pinned URL', () => {
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
    const download = gate();
    const instance = sesEventReceiver({
      topicArns: [TOPIC_ARN],
      clock,
      fetchCertificate: async () => {
        calls += 1;
        await download.opened;
        return signer.certificatePem;
      },
    });
    const all = Promise.all(
      Array.from({ length: 10 }, () => instance.receive(snsRequest(snsBody(message)))),
    );
    // All ten are issued and have had their turns while the one download is still open.
    while (calls === 0) await settle();
    for (let turn = 0; turn < 5; turn += 1) await settle();
    download.open();
    const outcomes = await all;
    expect(outcomes.every((outcome) => outcome.type === 'events')).toBe(true);
    expect(calls).toBe(1);
  });

  test('a failed URL is not fetched again within five minutes, and is after', async () => {
    const message = await sesNotification(signer, SES_DELIVERY);
    const clock = frozenClock('2026-10-06T12:01:00.000Z');
    let calls = 0;
    const instance = sesEventReceiver({
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

describe('sesEventReceiver — a flood of valid-looking certificate URLs', () => {
  const hexPath = (index: number): string =>
    `https://sns.us-west-2.amazonaws.com/SimpleNotificationService-${index.toString(16).padStart(32, '0')}.pem`;

  /** A forged URL's download is held until `forgedAnswer` opens — default, at once. */
  function flooded(forgedAnswer: Promise<void> = Promise.resolve()) {
    const fetched: string[] = [];
    const instance = sesEventReceiver({
      topicArns: [TOPIC_ARN],
      clock,
      fetchCertificate: async (url) => {
        fetched.push(url);
        if (url === CERT_URL) return signer.certificatePem;
        await forgedAnswer;
        throw notFound;
      },
    });
    return { instance, fetched };
  }

  test('100 concurrent distinct paths cost at most the in-flight cap, and the real cert stays', async () => {
    const forgedDownloads = gate();
    const { instance, fetched } = flooded(forgedDownloads.opened);
    const real = await sesNotification(signer, SES_DELIVERY);
    expect((await instance.receive(snsRequest(snsBody(real)))).type).toBe('events');
    let refused = 0;
    const all = Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        refusal(
          instance.receive(snsRequest(snsBody({ ...real, SigningCertURL: hexPath(index) }))),
        ).then((error) => {
          refused += 1;
          return error;
        }),
      ),
    );
    // Every one of the hundred is either refused or holding a download open — and the downloads
    // stay open until then, so a cap that let them through one after another would show.
    while (refused + fetched.length - 1 < 100) await settle();
    forgedDownloads.open();
    const forged = await all;
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
