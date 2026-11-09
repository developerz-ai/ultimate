// Where `nativePush()` stops spending requests: a credential refusal ends that provider's fan-out
// on its first device (one re-sign, never one per device), and a token the provider says it cannot
// parse is deleted after `PUSH_BAD_TOKEN_LIMIT` answers in a row — never on the first one.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { FrozenClock } from '@ultimat3/core';
import { frozenClock } from '@ultimat3/core';
import type { NativePusher } from './native-push';
import { nativePush, PUSH_BAD_TOKEN_LIMIT } from './native-push';
import type { FakeProviders, ProviderKeys } from './native-push-fixture';
import {
  accessToken,
  apnsRefusal,
  fakeProviders,
  fcmBadToken,
  fcmRefusal,
  ok,
  providerKeys,
} from './native-push-fixture';
import type { PushDeviceStore } from './push-device';
import { memoryPushDeviceStore } from './push-device';

const APNS = 'https://api.push.apple.com/3/device/';
const FCM = 'https://fcm.googleapis.com/v1/projects/postly-demo/messages:send';
const GOOGLE = 'https://oauth2.googleapis.com/token';
const ios = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const android = (n: number) => `fcm-token:${String(n).repeat(140)}`;

let keys: ProviderKeys;
let fake: FakeProviders;
let clock: FrozenClock;
let devices: PushDeviceStore;

const signal = new AbortController().signal;
const message = { titleKey: 'push.t', bodyKey: 'push.b', url: '/p/1', tag: 'p:1' };

const pusher = (): NativePusher =>
  nativePush({
    devices,
    apns: { teamId: 'TEAM123456', keyId: 'KEY1234567', topic: 'com.postly.app' },
    fcm: { projectId: 'postly-demo', clientEmail: 'push@postly-demo.iam.gserviceaccount.com' },
    fetch: fake.fetch,
    env: keys.env,
    clock,
    translate: () => (key) => key,
  });

const device = (platform: 'ios' | 'android', token: string) =>
  devices.save({ platform, token, actorId: 'ana', locale: 'en', timeZone: 'UTC', createdAt: 0 });

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const sent = (prefix: string) => fake.sent.filter((request) => request.url.startsWith(prefix));

beforeEach(async () => {
  keys = await providerKeys();
  fake = fakeProviders();
  fake.answer(GOOGLE, accessToken());
  fake.answer(APNS, ok());
  fake.answer(FCM, ok());
  clock = frozenClock('2026-11-06T09:00:00Z');
  devices = memoryPushDeviceStore();
});

describe('unit · nativePush — a credential refusal ends that provider’s fan-out', () => {
  test('APNs 403 on the first device: no other iOS device is tried, Android still is', async () => {
    for (const n of [1, 2, 3]) await device('ios', ios(n));
    await device('android', android(1));
    fake.answer(APNS, apnsRefusal(403, 'InvalidProviderToken'));
    expect(await codeOf(() => pusher().send({ to: 'ana', message, signal }))).toBe(
      'X_NOTIFY_PUSH_PROVIDER_REFUSED',
    );
    expect(sent(APNS)).toHaveLength(1);
    expect(sent(FCM)).toHaveLength(1);
  });

  test('FCM 401 on the first device stops the Android fan-out', async () => {
    for (const n of [1, 2, 3]) await device('android', android(n));
    fake.answer(FCM, fcmRefusal(401, 'THIRD_PARTY_AUTH_ERROR', 'UNAUTHENTICATED'));
    expect(await codeOf(() => pusher().send({ to: 'ana', message, signal }))).toBe(
      'X_NOTIFY_PUSH_PROVIDER_REFUSED',
    );
    expect(sent(FCM)).toHaveLength(1);
  });

  test('Google refusing the assertion is exchanged once, not once per device', async () => {
    for (const n of [1, 2, 3]) await device('android', android(n));
    fake.answer(GOOGLE, () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    expect(await codeOf(() => pusher().send({ to: 'ana', message, signal }))).toBe(
      'X_NOTIFY_PUSH_PROVIDER_REFUSED',
    );
    expect(sent(GOOGLE)).toHaveLength(1);
    expect(sent(FCM)).toEqual([]);
  });

  test('a payload refusal is not a credential one: every device is still tried', async () => {
    for (const n of [1, 2]) await device('ios', ios(n));
    fake.answer(APNS, apnsRefusal(413, 'PayloadTooLarge'));
    await codeOf(() => pusher().send({ to: 'ana', message, signal }));
    expect(sent(APNS)).toHaveLength(2);
  });
});

describe('unit · nativePush — a token the provider cannot parse', () => {
  const sends = async (count: number) => {
    for (let i = 0; i < count; i += 1) {
      await codeOf(() => pusher().send({ to: 'ana', message, signal }));
    }
  };

  test(`APNs BadDeviceToken deletes the row on answer ${String(PUSH_BAD_TOKEN_LIMIT)}, not before`, async () => {
    await device('ios', ios(1));
    fake.answer(APNS, apnsRefusal(400, 'BadDeviceToken'));
    await sends(PUSH_BAD_TOKEN_LIMIT - 1);
    expect(await devices.listFor('ana')).toHaveLength(1);
    await sends(1);
    expect(await devices.listFor('ana')).toEqual([]);
  });

  test('a delivery in between starts the count again', async () => {
    await device('ios', ios(1));
    const bad = apnsRefusal(400, 'BadDeviceToken');
    const answers = Array.from({ length: PUSH_BAD_TOKEN_LIMIT - 1 }, () => bad);
    fake.answer(APNS, ...answers, ok(), ...answers, bad);
    await sends(2 * (PUSH_BAD_TOKEN_LIMIT - 1) + 1);
    expect(await devices.listFor('ana')).toHaveLength(1);
  });

  test('FCM INVALID_ARGUMENT on message.token counts; one on the payload never does', async () => {
    await device('android', android(1));
    fake.answer(FCM, fcmRefusal(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT'));
    await sends(PUSH_BAD_TOKEN_LIMIT + 1);
    expect(await devices.listFor('ana')).toHaveLength(1);
    fake.answer(FCM, fcmBadToken());
    await sends(PUSH_BAD_TOKEN_LIMIT);
    expect(await devices.listFor('ana')).toEqual([]);
  });

  test('a short answer naming message.token is read whole, and counts the same', async () => {
    await device('android', android(1));
    fake.answer(FCM, () =>
      Response.json(
        { error: { details: [{ fieldViolations: [{ field: 'message.token' }] }] } },
        { status: 400 },
      ),
    );
    await sends(PUSH_BAD_TOKEN_LIMIT);
    expect(await devices.listFor('ana')).toEqual([]);
  });
});
