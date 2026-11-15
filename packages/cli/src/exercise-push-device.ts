// The device every actor holds in `x exercise`: the pass's push store answers each actor's stored
// subscriptions, else one stand-in on a listed push service with real P-256 keys, so a notifier's
// push is encrypted, signed and sent to the captured service — and recorded as a `push` effect by
// the room. As the memory mail driver accepts every address: a pusher that sends nothing shows.

import type { PushSubscriptionRecord, PushSubscriptionStore } from '@ultimat3/pwa';

/** A host `pushHostAllowed` lists, under a path no real browser hands out. */
const STAND_IN_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/x-exercise-';

const base64Url = (bytes: Uint8Array): string => bytes.toBase64({ alphabet: 'base64url' });

/** One receiver key pair for the whole pass: the private half is never read, only the public. */
async function standInKeys(): Promise<PushSubscriptionRecord['keys']> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const point = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { p256dh: base64Url(point), auth: base64Url(crypto.getRandomValues(new Uint8Array(16))) };
}

/**
 * `store`, with one stand-in device for an actor it holds none for. Never written: a subscribe the
 * pass runs stores its row in `store`, and a stand-in's removal (a 404 the captured service never
 * answers) removes nothing.
 */
export function withStandInDevice(store: PushSubscriptionStore): PushSubscriptionStore {
  let keys: Promise<PushSubscriptionRecord['keys']> | undefined;
  return {
    save: (record) => store.save(record),
    async listFor(actorId) {
      const held = await store.listFor(actorId);
      if (held.length > 0) return held;
      keys ??= standInKeys();
      const device: PushSubscriptionRecord = {
        endpoint: `${STAND_IN_ENDPOINT}${encodeURIComponent(actorId)}`,
        keys: await keys,
        locale: 'en',
        timeZone: 'UTC',
        actorId,
        createdAt: 0,
        expirationTime: null,
      };
      return [device];
    },
    remove: (endpoint, actorId) =>
      endpoint.startsWith(STAND_IN_ENDPOINT)
        ? Promise.resolve(false)
        : store.remove(endpoint, actorId),
  };
}
