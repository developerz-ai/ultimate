// The certificate cache's bounds, directly: LRU keeps the certificate in use, a failure is
// remembered for its TTL, and identical concurrent lookups share one download.

import { beforeAll, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { type SnsSigner, snsSigner } from './delivery-event-fixture';
import { createSnsCertificateCache } from './sns-certificate-cache';

let signer: SnsSigner;
beforeAll(async () => {
  signer = await snsSigner();
});

const url = (index: number): string =>
  `https://sns.us-west-2.amazonaws.com/SimpleNotificationService-${index.toString(16).padStart(32, '0')}.pem`;

describe('createSnsCertificateCache', () => {
  test('LRU: the certificate in use survives nine others arriving', async () => {
    const fetched: string[] = [];
    const cache = createSnsCertificateCache({
      clock: frozenClock(0),
      fetchCertificate: async (at) => {
        fetched.push(at);
        return signer.certificatePem;
      },
    });
    await cache.spkiFor(url(0));
    for (let index = 1; index <= 9; index += 1) {
      await cache.spkiFor(url(index));
      await cache.spkiFor(url(0));
    }
    expect(fetched.filter((at) => at === url(0))).toHaveLength(1);
    // The least recently used of the others was evicted, so it downloads again.
    await cache.spkiFor(url(1));
    expect(fetched.filter((at) => at === url(1))).toHaveLength(2);
  });

  test('concurrent identical lookups share one download', async () => {
    let calls = 0;
    const cache = createSnsCertificateCache({
      fetchCertificate: async () => {
        calls += 1;
        await Bun.sleep(5);
        return signer.certificatePem;
      },
    });
    await Promise.all(Array.from({ length: 10 }, () => cache.spkiFor(url(7))));
    expect(calls).toBe(1);
  });
});
