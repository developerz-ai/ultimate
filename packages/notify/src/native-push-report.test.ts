// The edges of `nativePush()`'s native fields and its per-send report: a name is screened before
// any device is looked up, every documented name character is taken in every position, a refused
// field's `fix:` parses as code, and `removed` counts each way a row is deleted.

import { beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import type { NativePushReport } from './native-push';
import { nativePush, PUSH_BAD_TOKEN_LIMIT } from './native-push';
import type { FakeProviders, ProviderKeys } from './native-push-fixture';
import { accessToken, fakeProviders, fcmBadToken, ok, providerKeys } from './native-push-fixture';
import type { PushDeviceStore } from './push-device';
import { memoryPushDeviceStore } from './push-device';

const APNS = 'https://api.push.apple.com/3/device/';
const FCM = 'https://fcm.googleapis.com/v1/projects/postly-demo/messages:send';
const GOOGLE = 'https://oauth2.googleapis.com/token';
const IOS = 'ab'.repeat(32);
const ANDROID = `fcm-token:${'x'.repeat(140)}`;

let keys: ProviderKeys;
let fake: FakeProviders;
let devices: PushDeviceStore;
let reports: NativePushReport[];

const signal = new AbortController().signal;
const message = { titleKey: 'push.t', bodyKey: 'push.b', url: '/p/1', tag: 'p:1' };

const pusher = () =>
  nativePush({
    devices,
    apns: { teamId: 'TEAM123456', keyId: 'KEY1234567', topic: 'com.postly.app' },
    fcm: { projectId: 'postly-demo', clientEmail: 'push@postly-demo.iam.gserviceaccount.com' },
    fetch: fake.fetch,
    env: keys.env,
    clock: frozenClock('2026-11-06T09:00:00Z'),
    translate: () => (key) => key,
    onReport: (sent) => reports.push(sent.report),
  });

const device = (platform: 'ios' | 'android', token: string) =>
  devices.save({ platform, token, actorId: 'ana', locale: 'en', timeZone: 'UTC', createdAt: 0 });

const refusalOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return error;
  }
  return expect.unreachable('expected an UltimateError');
};

beforeEach(async () => {
  keys = await providerKeys();
  fake = fakeProviders();
  fake.answer(GOOGLE, accessToken());
  fake.answer(APNS, ok());
  fake.answer(FCM, ok());
  devices = memoryPushDeviceStore();
  reports = [];
});

describe('unit · nativePush — native field names', () => {
  test('a bad field is refused before the device lookup, for a recipient with no device too', async () => {
    const looked: string[] = [];
    const listFor = devices.listFor.bind(devices);
    devices = {
      ...devices,
      listFor: (actorId) => {
        looked.push(actorId);
        return listFor(actorId);
      },
    };
    const refused = await refusalOf(() =>
      pusher().send({ to: 'nobody', message: { ...message, sound: 'my sound' }, signal }),
    );
    expect(refused.code).toBe('X_NOTIFY_PUSH_MESSAGE_INVALID');
    expect(looked).toEqual([]);
    expect(fake.sent).toEqual([]);
  });

  test("every documented character is taken in every position, a leading '_', '.' or '-' too", async () => {
    await device('android', ANDROID);
    const names = ['_mentions', '.chime', '-reply', 'a', 'x'.repeat(64)];
    for (const name of names) {
      await pusher().send({ to: 'ana', message: { ...message, channelId: name }, signal });
    }
    const sentIds = fake.sent
      .filter((sent) => sent.url === FCM)
      .map((sent) => JSON.parse(sent.body).message.android.notification.channel_id);
    expect(sentIds).toEqual(names);
  });

  test("each refused field's fix is a pushChannel() call that keeps the message and sets a valid field", async () => {
    await device('ios', IOS);
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const own = (args: { readonly n: number }) => ({ ...message, url: `/p/${String(args.n)}` });
    for (const [field, value] of [
      ['sound', 'my sound'],
      ['category', ''],
      ['channelId', 'c'.repeat(65)],
      ['interruptionLevel', 'loud'],
    ] as const) {
      const refused = await refusalOf(() =>
        pusher().send({ to: 'ana', message: { ...message, [field]: value }, signal }),
      );
      const [code = ''] = refused.fix.split('   # ');
      expect(code).not.toContain('…');
      // The snippet run as written: `pushChannel` hands back its options, `message` is the app's own.
      const run = new Function('pushChannel', 'pusher', 'message', `return ${code};`);
      transpiler.transformSync(`void ${code};`);
      const options = run((opts: unknown) => opts, undefined, own) as {
        message: (args: { readonly n: number }) => Record<string, unknown>;
      };
      const repaired = options.message({ n: 7 });
      expect(repaired).toEqual({ ...own({ n: 7 }), [field]: repaired[field] });
      expect(repaired[field]).toBeString();
      expect(repaired[field]).not.toBe('');
      await pusher().send({ to: 'ana', message: { ...message, ...repaired }, signal });
    }
  });

  test('a bad interruption level is described as a fixed value, not a name the app registers', async () => {
    const refused = await refusalOf(() =>
      pusher().send({
        to: 'ana',
        message: { ...message, interruptionLevel: 'loud' as 'active' },
        signal,
      }),
    );
    expect(refused.cause).not.toContain('registered');
    expect(refused.cause).toContain('passive, active, time-sensitive, critical');
  });
});

describe('unit · nativePush — what the report counts as removed', () => {
  test('a stored token no provider could take is removed, beside an accepted device', async () => {
    await device('ios', `${IOS}/../../x`);
    await device('android', ANDROID);
    await pusher().send({ to: 'ana', message, signal });
    expect(reports).toEqual([{ accepted: 1, refused: 0, removed: 1, skipped: 0 }]);
    expect((await devices.listFor('ana')).map((row) => row.token)).toEqual([ANDROID]);
  });

  test(`a bad token is refused, then removed on its answer ${String(PUSH_BAD_TOKEN_LIMIT)}`, async () => {
    await device('ios', IOS);
    await device('android', ANDROID);
    fake.answer(FCM, fcmBadToken());
    for (let i = 0; i < PUSH_BAD_TOKEN_LIMIT; i += 1) {
      await pusher().send({ to: 'ana', message, signal });
    }
    expect((await devices.listFor('ana')).map((row) => row.token)).toEqual([IOS]);
    const kept = { accepted: 1, refused: 1, removed: 0, skipped: 0 };
    expect(reports).toEqual([
      ...Array.from({ length: PUSH_BAD_TOKEN_LIMIT - 1 }, () => kept),
      { accepted: 1, refused: 0, removed: 1, skipped: 0 },
    ]);
  });
});
