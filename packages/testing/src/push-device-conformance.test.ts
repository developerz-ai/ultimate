// The push-device suite over the memory store, and the proof it can fail: a store keyed by
// `(actor, token)` — the first person goes on receiving the second person's notifications.

import { describe, expect, test } from 'bun:test';
import type { PushDeviceStore } from '@ultimat3/notify';
import { memoryPushDeviceStore } from '@ultimat3/notify';
import { PUSH_DEVICE_STORE_CHECKS, pushDeviceStoreConformance } from './push-device-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

describe(testName('unit', 'the memory push device store'), () => {
  behavesLike(pushDeviceStoreConformance, () => memoryPushDeviceStore());
});

/** Saves never move a device: a re-register by another actor leaves the old owner listed. */
const keyedByActor = (): PushDeviceStore => {
  const perActor = new Map<string, PushDeviceStore>();
  const of = (actorId: string): PushDeviceStore => {
    const found = perActor.get(actorId) ?? memoryPushDeviceStore();
    perActor.set(actorId, found);
    return found;
  };
  const any = async <T>(each: (store: PushDeviceStore) => Promise<T>): Promise<T[]> =>
    Promise.all([...perActor.values()].map(each));
  return {
    save: (record) => of(record.actorId).save(record),
    listFor: (actorId) => of(actorId).listFor(actorId),
    remove: async (platform, token, actorId) =>
      actorId === undefined
        ? (await any((store) => store.remove(platform, token))).includes(true)
        : of(actorId).remove(platform, token, actorId),
    noteBadToken: async (platform, token) =>
      Math.max(0, ...(await any((store) => store.noteBadToken(platform, token)))),
    clearBadToken: async (platform, token) => {
      await any((store) => store.clearBadToken(platform, token));
    },
  };
};

describe(testName('unit', 'a store keyed by actor fails conformance'), () => {
  test('the re-register check catches it, and the memory store passes the same check', async () => {
    const [moves] = PUSH_DEVICE_STORE_CHECKS;
    if (moves === undefined) return expect.unreachable('no push device checks');
    await expect(moves.run(keyedByActor())).rejects.toThrow();
    await moves.run(memoryPushDeviceStore());
  });

  test('every check has a name of its own', () => {
    const names = PUSH_DEVICE_STORE_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
