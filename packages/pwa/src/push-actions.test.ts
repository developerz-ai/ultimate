// The subscription surface through the one authz path (`.as()`): stored against the actor the call
// ran as, refused for an agent, an anonymous caller and a malformed browser subscription, and an
// unsubscribe that can only ever reach the caller's own device.

import { afterEach, describe, expect, test } from 'bun:test';
import { registerAction, resetActions } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import { agentActor, anonymousActor, userActor } from '@ultimat3/core';
import { pushSubscribe, pushUnsubscribe } from './push-actions';
import { encodeBase64Url } from './push-bytes';
import { installWebPush, resetWebPush } from './push-runtime';
import type { PushSubscriptionStore } from './push-store';
import { memoryPushSubscriptionStore } from './push-store';
import { DEV_VAPID_KEYS } from './vapid-keys';

afterEach(() => {
  resetActions();
  resetWebPush();
});

const ana = userActor({ id: 'ana', orgId: 'o1', permissions: ['push:subscribe'] });
const ben = userActor({ id: 'ben', orgId: 'o1', permissions: ['push:subscribe'] });

const p256dh = async (): Promise<string> => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  return encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
};

const body = async (endpoint = 'https://fcm.example.test/send/abc') => ({
  endpoint,
  expirationTime: null,
  keys: { p256dh: await p256dh(), auth: encodeBase64Url(new Uint8Array(16).fill(7)) },
  locale: 'de',
  timeZone: 'Europe/Berlin',
});

async function surface(): Promise<{
  readonly store: PushSubscriptionStore;
  readonly subscribe: ReturnType<typeof pushSubscribe>;
  readonly unsubscribe: ReturnType<typeof pushUnsubscribe>;
}> {
  const store = memoryPushSubscriptionStore();
  await installWebPush({ store, keys: DEV_VAPID_KEYS, subject: 'mailto:ops@example.test' });
  const subscribe = registerAction(
    'subscribePush',
    pushSubscribe({ permission: 'push:subscribe' }),
  );
  const unsubscribe = registerAction(
    'unsubscribePush',
    pushUnsubscribe({ permission: 'push:subscribe' }),
  );
  return { store, subscribe, unsubscribe };
}

const refusal = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return expect.unreachable('expected a refusal');
};

describe('unit · pushSubscribe / pushUnsubscribe', () => {
  test('a subscription is stored against the actor the call ran as, with its locale', async () => {
    const { store, subscribe } = await surface();
    const input = await body();
    expect(await subscribe.as(ana, input)).toEqual({ endpoint: input.endpoint });
    expect(await store.listFor('ana')).toMatchObject([
      { endpoint: input.endpoint, actorId: 'ana', locale: 'de', timeZone: 'Europe/Berlin' },
    ]);
  });

  test('the same browser subscribed by a second person is theirs now', async () => {
    const { store, subscribe } = await surface();
    const input = await body();
    await subscribe.as(ana, input);
    await subscribe.as(ben, input);
    expect(await store.listFor('ana')).toEqual([]);
    expect(await store.listFor('ben')).toHaveLength(1);
  });

  test('an agent, an anonymous caller and an actor without the permission are refused', async () => {
    const { subscribe } = await surface();
    const input = await body();
    const agent: Actor = agentActor({ id: 'bot', orgId: 'o1', permissions: ['push:subscribe'] });
    expect(await refusal(() => subscribe.as(agent, input))).toBe('X_FORBIDDEN');
    expect(await refusal(() => subscribe.as(anonymousActor(), input))).toBe('X_UNAUTHENTICATED');
    const bare = userActor({ id: 'cy', orgId: 'o1' });
    expect(await refusal(() => subscribe.as(bare, input))).toBe('X_FORBIDDEN');
  });

  test('a subscription no browser produced is refused before it is stored', async () => {
    const { store, subscribe } = await surface();
    const good = await body();
    expect(
      await refusal(() => subscribe.as(ana, { ...good, endpoint: 'http://evil.example/x' })),
    ).toBe('X_PWA_PUSH_SUBSCRIPTION_INVALID');
    expect(
      await refusal(() => subscribe.as(ana, { ...good, keys: { ...good.keys, p256dh: 'AAAA' } })),
    ).toBe('X_PWA_PUSH_SUBSCRIPTION_INVALID');
    expect(
      await refusal(() => subscribe.as(ana, { ...good, keys: { ...good.keys, auth: 'AAAA' } })),
    ).toBe('X_PWA_PUSH_SUBSCRIPTION_INVALID');
    expect(await store.listFor('ana')).toEqual([]);
  });

  test('unsubscribe removes the caller’s own device and never another person’s', async () => {
    const { store, subscribe, unsubscribe } = await surface();
    const input = await body();
    await subscribe.as(ana, input);
    expect(await unsubscribe.as(ben, { endpoint: input.endpoint })).toEqual({ removed: false });
    expect(await store.listFor('ana')).toHaveLength(1);
    expect(await unsubscribe.as(ana, { endpoint: input.endpoint })).toEqual({ removed: true });
    expect(await unsubscribe.as(ana, { endpoint: input.endpoint })).toEqual({ removed: false });
  });

  test('with no Web Push runtime installed, both refuse by code — never a silent no-op', async () => {
    const subscribe = registerAction(
      'subscribePush',
      pushSubscribe({ permission: 'push:subscribe' }),
    );
    expect(await refusal(async () => subscribe.as(ana, await body()))).toBe(
      'X_PWA_PUSH_UNCONFIGURED',
    );
  });
});
