// The push-subscription suite over the memory store, and the proof it can fail: a store whose
// re-subscribe keeps the OLD owner — the first person's device goes on receiving the second's mail.

import { describe, expect, test } from 'bun:test';
import type { PushSubscriptionStore } from '@ultimat3/pwa';
import { memoryPushSubscriptionStore } from '@ultimat3/pwa';
import {
  PUSH_SUBSCRIPTION_STORE_CHECKS,
  pushSubscriptionStoreConformance,
} from './push-subscription-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the memory push subscription store'), () => {
  behavesLike(pushSubscriptionStoreConformance, () => memoryPushSubscriptionStore());
});

/** First write wins: an `on conflict do nothing` where the contract says `do update`. */
const firstWriteWins = (): PushSubscriptionStore => {
  const inner = memoryPushSubscriptionStore();
  const seen = new Set<string>();
  return {
    ...inner,
    async save(record) {
      if (seen.has(record.endpoint)) return;
      seen.add(record.endpoint);
      await inner.save(record);
    },
  };
};

describe(testName('unit', 'a store that never hands a device over fails conformance'), () => {
  test('the re-subscribe check catches it, and the memory store passes the same check', async () => {
    const [handover] = PUSH_SUBSCRIPTION_STORE_CHECKS;
    if (handover === undefined) return expect.unreachable('no push subscription checks');
    await expect(handover.run(firstWriteWins())).rejects.toThrow();
    await handover.run(memoryPushSubscriptionStore());
  });

  test('every check has a name of its own', () => {
    const names = PUSH_SUBSCRIPTION_STORE_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
