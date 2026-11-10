// `nativePush()` against a fake APNs and a fake FCM: what reaches each provider (and that nothing
// else does — the data-only push above all), the two credentials minted once and re-minted before
// they expire, dead tokens dropped, refusals coded, and the private keys never leaving the process.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { FrozenClock } from '@ultimat3/core';
import { frozenClock, installLogSink } from '@ultimat3/core';
import type { NativePusher } from './native-push';
import { nativePush } from './native-push';
import type { FakeProviders, ProviderKeys } from './native-push-fixture';
import {
  accessToken,
  apnsRefusal,
  fakeProviders,
  fcmRefusal,
  ok,
  providerKeys,
  readJwt,
} from './native-push-fixture';
import type { PushDeviceStore } from './push-device';
import { memoryPushDeviceStore } from './push-device';

const APNS = 'https://api.push.apple.com/3/device/';
const FCM = 'https://fcm.googleapis.com/v1/projects/postly-demo/messages:send';
const GOOGLE = 'https://oauth2.googleapis.com/token';
const IOS = 'ab'.repeat(32);
const ANDROID = `fcm-token:${'x'.repeat(140)}`;
const APNS_OPTIONS = { teamId: 'TEAM123456', keyId: 'KEY1234567', topic: 'com.postly.app' };
const FCM_OPTIONS = {
  projectId: 'postly-demo',
  clientEmail: 'push@postly-demo.iam.gserviceaccount.com',
};

let keys: ProviderKeys;
let fake: FakeProviders;
let clock: FrozenClock;
let devices: PushDeviceStore;
let logs: string[];
let releaseLogSink: () => void;

const signal = new AbortController().signal;

const pusher = (env: Readonly<Record<string, string>> = keys.env): NativePusher =>
  nativePush({
    devices,
    apns: APNS_OPTIONS,
    fcm: FCM_OPTIONS,
    fetch: fake.fetch,
    env,
    clock,
    // The rendered text names its locale, so a test sees which one each device got.
    translate: (locale) => (key, params) => `${locale}|${key}|${String(params?.['who'] ?? '')}`,
  });

const device = (platform: 'ios' | 'android', token: string, locale: string) =>
  devices.save({ platform, token, actorId: 'ana', locale, timeZone: 'UTC', createdAt: 0 });

const message = {
  titleKey: 'push.comment.title',
  bodyKey: 'push.comment.body',
  params: { who: 'Kenji' },
  url: '/posts/p1',
  tag: 'post:p1',
};

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return expect.unreachable('expected a refusal');
};

const toApns = () => fake.sent.filter((sent) => sent.url.startsWith(APNS));
const toFcm = () => fake.sent.filter((sent) => sent.url === FCM);
const toGoogle = () => fake.sent.filter((sent) => sent.url === GOOGLE);

beforeEach(async () => {
  keys = await providerKeys();
  fake = fakeProviders();
  fake.answer(GOOGLE, accessToken());
  fake.answer(APNS, ok());
  fake.answer(FCM, ok());
  clock = frozenClock('2026-11-06T09:00:00Z');
  devices = memoryPushDeviceStore();
  logs = [];
  releaseLogSink = installLogSink((line) => logs.push(line));
});

afterEach(() => {
  releaseLogSink();
});

describe('unit · nativePush — what leaves', () => {
  test('a visible push reaches each device in its own locale, APNs over HTTP/2 with a signed token', async () => {
    await device('ios', IOS, 'es');
    await device('android', ANDROID, 'de');
    await pusher().send({ to: 'ana', message, signal });

    const [apns] = toApns();
    expect(apns?.url).toBe(`${APNS}${IOS}`);
    expect(apns?.protocol).toBe('http2');
    expect(apns?.headers['apns-topic']).toBe('com.postly.app');
    expect(apns?.headers['apns-push-type']).toBe('alert');
    expect(apns?.headers['apns-collapse-id']).toBe('post:p1');
    expect(JSON.parse(apns?.body ?? '')).toEqual({
      aps: { alert: { title: 'es|push.comment.title|Kenji', body: 'es|push.comment.body|Kenji' } },
      url: '/posts/p1',
    });
    const jwt = await readJwt(
      (apns?.headers['authorization'] ?? '').replace(/^bearer /, ''),
      keys.apnsPublic,
      { name: 'ECDSA', hash: 'SHA-256' },
    );
    expect(jwt).toEqual({
      header: { kid: 'KEY1234567', alg: 'ES256' },
      claims: { iss: 'TEAM123456', iat: Math.floor(clock.now().getTime() / 1000) },
      valid: true,
    });

    const [fcm] = toFcm();
    expect(fcm?.headers['authorization']).toBe('Bearer ya29.fake');
    expect(JSON.parse(fcm?.body ?? '').message).toEqual({
      token: ANDROID,
      notification: { title: 'de|push.comment.title|Kenji', body: 'de|push.comment.body|Kenji' },
      data: { url: '/posts/p1' },
      android: { priority: 'high', ttl: '86400s', collapse_key: 'post:p1' },
    });
    // The assertion Google exchanged: signed by the service account, for the messaging scope.
    const form = new URLSearchParams(toGoogle()[0]?.body ?? '');
    const assertion = await readJwt(form.get('assertion') ?? '', keys.fcmPublic, {
      name: 'RSASSA-PKCS1-v1_5',
    });
    expect(assertion.valid).toBe(true);
    expect(assertion.claims).toMatchObject({
      iss: FCM_OPTIONS.clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: GOOGLE,
    });
  });

  test('a data-only push carries the id and NOTHING else, to either provider', async () => {
    await device('ios', IOS, 'es');
    await device('android', ANDROID, 'de');
    await pusher().sendData({ to: 'ana', data: { approvalId: 'appr_42' }, signal });

    const [apns] = toApns();
    expect(apns?.body).toBe(
      JSON.stringify({ approvalId: 'appr_42', aps: { 'content-available': 1 } }),
    );
    expect(Object.keys(apns?.headers ?? {}).sort()).toEqual([
      'apns-priority',
      'apns-push-type',
      'apns-topic',
      'authorization',
    ]);
    expect(apns?.headers['apns-push-type']).toBe('background');
    expect(apns?.headers['apns-priority']).toBe('5');

    const [fcm] = toFcm();
    expect(fcm?.body).toBe(
      JSON.stringify({
        message: { token: ANDROID, data: { approvalId: 'appr_42' }, android: { priority: 'high' } },
      }),
    );
    expect(Object.keys(fcm?.headers ?? {}).sort()).toEqual(['authorization', 'content-type']);
    // Three requests in all — APNs, Google's token, FCM — and no other byte went anywhere.
    expect(fake.sent).toHaveLength(3);
  });

  test('a data push carrying more than ids is refused before a single request', async () => {
    await device('ios', IOS, 'es');
    const send = (data: Record<string, unknown>) => () =>
      pusher().sendData({ to: 'ana', data: data as Record<string, string>, signal });
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${String(i)}`, 'v']));
    for (const data of [
      { aps: 'x' },
      { 'google.c': 'x' },
      { notification: 'x' },
      many,
      { body: 'x'.repeat(257) },
      { count: 3 },
      {},
    ]) {
      expect(await codeOf(send(data))).toBe('X_NOTIFY_PUSH_MESSAGE_INVALID');
    }
    expect(fake.sent).toEqual([]);
  });

  test('a stored token that is not hex never reaches the APNs path — it is dropped', async () => {
    await device('ios', `${'ab'.repeat(32)}/../../x`, 'es');
    await pusher().send({ to: 'ana', message, signal });
    expect(fake.sent).toEqual([]);
    expect(await devices.listFor('ana')).toEqual([]);
  });
});

describe('unit · nativePush — credentials', () => {
  test('one APNs token and one Google access token serve every send until shortly before expiry', async () => {
    await device('ios', IOS, 'es');
    await device('android', ANDROID, 'de');
    const push = pusher();
    await push.send({ to: 'ana', message, signal });
    clock.advance(49 * 60_000);
    await push.send({ to: 'ana', message, signal });
    const bearers = () => new Set(toApns().map((sent) => sent.headers['authorization']));
    expect(bearers().size).toBe(1);
    expect(toGoogle()).toHaveLength(1);
    // Past 50 minutes both are replaced before the provider would refuse them.
    clock.advance(6 * 60_000);
    await push.send({ to: 'ana', message, signal });
    expect(bearers().size).toBe(2);
    expect(toGoogle()).toHaveLength(2);
  });

  test('a missing key refuses by its variable name, sends nothing, and no key text is logged', async () => {
    await device('ios', IOS, 'es');
    const error = await pusher({})
      .send({ to: 'ana', message, signal })
      .then(
        () => expect.unreachable('a missing key refuses'),
        (thrown: unknown) => thrown as { code: string; cause: string; fix: string },
      );
    expect(error.code).toBe('X_ENV_MISSING');
    expect(error.fix).toStartWith('x secrets set ULTIMATE_APNS_PRIVATE_KEY');
    expect(fake.sent).toEqual([]);
  });

  test('a key that is not one is refused without its text in the cause', async () => {
    await device('android', ANDROID, 'de');
    const broken = '-----BEGIN PRIVATE KEY-----\nTOPSECRETTOPSECRET\n-----END PRIVATE KEY-----';
    const error = await pusher({ ...keys.env, ULTIMATE_FCM_PRIVATE_KEY: broken })
      .send({ to: 'ana', message, signal })
      .then(
        () => expect.unreachable('an unreadable key refuses'),
        (thrown: unknown) => thrown as { code: string; cause: string },
      );
    expect(error.code).toBe('X_CONFIG_INVALID');
    expect(error.cause).not.toContain('TOPSECRET');
  });

  test('the private keys never leave the process, in a request or a log line', async () => {
    await device('ios', IOS, 'es');
    await device('android', ANDROID, 'de');
    fake.answer(APNS, apnsRefusal(403, 'InvalidProviderToken'));
    expect(await codeOf(() => pusher().send({ to: 'ana', message, signal }))).toBe(
      'X_NOTIFY_PUSH_PROVIDER_REFUSED',
    );
    const wire = JSON.stringify(fake.sent) + logs.join('\n');
    for (const pem of keys.secrets) {
      const body = pem.replaceAll('\\n', '\n').split('\n')[1] ?? '';
      expect(body.length).toBeGreaterThan(40);
      expect(wire).not.toContain(body.slice(0, 40));
    }
    expect(logs.join('\n')).not.toContain(IOS);
  });

  test('a declaration Apple or Google could never accept fails where it is written', () => {
    expect(() => nativePush({ devices, apns: { ...APNS_OPTIONS, teamId: 'team' } })).toThrow(
      expect.objectContaining({ code: 'X_CONFIG_INVALID' }),
    );
    expect(() =>
      nativePush({ devices, fcm: { ...FCM_OPTIONS, projectId: 'Bad/Project' } }),
    ).toThrow(expect.objectContaining({ code: 'X_CONFIG_INVALID' }));
  });
});

describe('unit · nativePush — answers', () => {
  test('APNs 410 and FCM UNREGISTERED delete the device, and the delivery still settles', async () => {
    await device('ios', IOS, 'es');
    await device('android', ANDROID, 'de');
    fake.answer(APNS, apnsRefusal(410, 'Unregistered'));
    fake.answer(FCM, fcmRefusal(404, 'UNREGISTERED', 'NOT_FOUND'));
    await pusher().send({ to: 'ana', message, signal });
    expect(await devices.listFor('ana')).toEqual([]);
  });

  test('a 404 that does not say UNREGISTERED — a wrong project — deletes nothing and refuses', async () => {
    await device('android', ANDROID, 'de');
    fake.answer(FCM, () =>
      Response.json({ error: { code: 404, status: 'NOT_FOUND' } }, { status: 404 }),
    );
    expect(await codeOf(() => pusher().send({ to: 'ana', message, signal }))).toBe(
      'X_NOTIFY_PUSH_PROVIDER_REFUSED',
    );
    expect(await devices.listFor('ana')).toHaveLength(1);
  });

  test('a refusal every device gets fails the delivery, and the next send signs a fresh token', async () => {
    await device('ios', IOS, 'es');
    fake.answer(APNS, apnsRefusal(403, 'ExpiredProviderToken'), ok());
    const push = pusher();
    expect(await codeOf(() => push.send({ to: 'ana', message, signal }))).toBe(
      'X_NOTIFY_PUSH_PROVIDER_REFUSED',
    );
    await push.send({ to: 'ana', message, signal });
    expect(new Set(toApns().map((sent) => sent.headers['authorization'])).size).toBe(2);
    expect(await devices.listFor('ana')).toHaveLength(1);
  });

  test('one device refused for good does not fail a person whose other device took it', async () => {
    await device('ios', IOS, 'es');
    await device('android', ANDROID, 'de');
    fake.answer(APNS, apnsRefusal(400, 'BadDeviceToken'));
    await pusher().send({ to: 'ana', message, signal });
    expect(toFcm()).toHaveLength(1);
    expect(logs.join('\n')).toContain('X_NOTIFY_PUSH_PROVIDER_REFUSED');
    // BadDeviceToken is also a sandbox token sent to production: never read as "gone".
    expect(await devices.listFor('ana')).toHaveLength(2);
  });

  test('a provider blip is rethrown for the retry, after every other device was tried', async () => {
    await device('ios', IOS, 'es');
    await device('android', ANDROID, 'de');
    fake.answer(APNS, () => new Response(null, { status: 503 }));
    expect(await codeOf(() => pusher().send({ to: 'ana', message, signal }))).toBe(
      'X_OUTBOUND_UNAVAILABLE',
    );
    expect(toFcm()).toHaveLength(1);
  });

  test('a provider that never answers is cut off at the deadline', async () => {
    await device('android', ANDROID, 'de');
    const hung = nativePush({
      devices,
      fcm: FCM_OPTIONS,
      env: keys.env,
      clock,
      deadlineMs: 20,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    });
    expect(await codeOf(() => hung.send({ to: 'ana', message, signal }))).toBe(
      'X_OUTBOUND_TIMEOUT',
    );
  });

  test('a person with no device is sent nothing, and that is no failure', async () => {
    await pusher().send({ to: 'nobody', message, signal });
    await pusher().sendData({ to: 'nobody', data: { id: '1' }, signal });
    expect(fake.sent).toEqual([]);
  });
});
