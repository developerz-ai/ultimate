// The browser half against a stub host: permission asked only when undecided, the key from the
// page's meta handed to `pushManager.subscribe` as bytes, the subscription saved with the page's
// locale and the device's zone — and the server told BEFORE the browser on unsubscribe.

import { describe, expect, test } from 'bun:test';
import type { PushClientHost, PushSubscriptionInput, PushSubscriptionLike } from './push-client';
import { pushPermission, subscribeToPush, unsubscribeFromPush } from './push-client';
import { DEV_VAPID_KEYS } from './vapid-keys';

interface Recorder {
  readonly log: string[];
  subscribedWith?: Uint8Array;
}

function host(
  overrides: Partial<PushClientHost> & {
    readonly permission?: 'default' | 'denied' | 'granted';
    readonly answer?: 'default' | 'denied' | 'granted';
    readonly existing?: boolean;
  },
  recorder: Recorder,
): PushClientHost {
  const subscription: PushSubscriptionLike = {
    endpoint: 'https://fcm.example.test/send/1',
    toJSON: () => ({
      endpoint: 'https://fcm.example.test/send/1',
      expirationTime: null,
      keys: { p256dh: 'BPk', auth: 'au' },
    }),
    unsubscribe: async () => {
      recorder.log.push('browser:unsubscribe');
      return true;
    },
  };
  return {
    serviceWorker: {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: async () => (overrides.existing === true ? subscription : null),
          subscribe: async (options) => {
            recorder.log.push(`subscribe:userVisibleOnly=${String(options.userVisibleOnly)}`);
            recorder.subscribedWith = options.applicationServerKey;
            return subscription;
          },
        },
      }),
    },
    notification: {
      permission: overrides.permission ?? 'default',
      requestPermission: async () => {
        recorder.log.push('prompt');
        return overrides.answer ?? 'granted';
      },
    },
    pushKey: DEV_VAPID_KEYS.publicKey,
    locale: 'de',
    timeZone: 'Europe/Berlin',
    ...overrides,
  };
}

describe('unit · @ultimat3/pwa/client', () => {
  test('asks, subscribes with the meta key as 65 bytes, and saves locale and zone', async () => {
    const recorder: Recorder = { log: [] };
    const saved: PushSubscriptionInput[] = [];
    const outcome = await subscribeToPush(
      {
        save: async (input) => {
          saved.push(input);
        },
      },
      host({}, recorder),
    );
    expect(outcome).toEqual({ status: 'subscribed', endpoint: 'https://fcm.example.test/send/1' });
    expect(recorder.log).toEqual(['prompt', 'subscribe:userVisibleOnly=true']);
    expect(recorder.subscribedWith?.byteLength).toBe(65);
    expect(recorder.subscribedWith?.[0]).toBe(4);
    expect(saved).toEqual([
      {
        endpoint: 'https://fcm.example.test/send/1',
        expirationTime: null,
        keys: { p256dh: 'BPk', auth: 'au' },
        locale: 'de',
        timeZone: 'Europe/Berlin',
      },
    ]);
  });

  test('a decided permission is not asked again; an existing subscription is re-saved, not replaced', async () => {
    const recorder: Recorder = { log: [] };
    let saves = 0;
    await subscribeToPush(
      {
        save: async () => {
          saves += 1;
        },
      },
      host({ permission: 'granted', existing: true }, recorder),
    );
    expect(recorder.log).toEqual([]);
    expect(saves).toBe(1);
  });

  test('denied, unsupported and unconfigured are outcomes — and nothing is saved', async () => {
    const recorder: Recorder = { log: [] };
    const save = async (): Promise<void> => expect.unreachable('nothing to save');
    expect(await subscribeToPush({ save }, host({ answer: 'denied' }, recorder))).toEqual({
      status: 'denied',
    });
    expect(await subscribeToPush({ save }, host({ serviceWorker: undefined }, recorder))).toEqual({
      status: 'unsupported',
    });
    expect(await subscribeToPush({ save }, host({ pushKey: null }, recorder))).toEqual({
      status: 'unconfigured',
    });
    expect(pushPermission(host({ notification: undefined }, recorder))).toBe('unsupported');
    expect(pushPermission(host({ permission: 'default' }, recorder))).toBe('prompt');
  });

  test('unsubscribe tells the server first, then the browser', async () => {
    const recorder: Recorder = { log: [] };
    const removed = await unsubscribeFromPush(
      {
        remove: async ({ endpoint }) => {
          recorder.log.push(`server:${endpoint}`);
        },
      },
      host({ existing: true }, recorder),
    );
    expect(removed).toBe(true);
    expect(recorder.log).toEqual(['server:https://fcm.example.test/send/1', 'browser:unsubscribe']);
    expect(await unsubscribeFromPush({ remove: async () => undefined }, host({}, recorder))).toBe(
      false,
    );
  });
});
