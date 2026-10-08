// The sender against a stub push service: every RFC 8030 header it must send, a
// body the subscriber can decrypt, and each answer a push service gives — 201 delivered, 404/410
// gone (and deleted), 429/5xx retried, 403 refused for good.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { PushSubscriptionRecord, Translate } from './push';
import { encodeBase64Url } from './push-bytes';
import { installWebPush, resetWebPush } from './push-runtime';
import { sendPushMessage } from './push-send';
import { memoryPushSubscriptionStore } from './push-store';
import { generateVapidKeys, importVapidKeys } from './vapid';
import { pushToActor, webPush } from './web-push';

const NOW = new Date('2026-10-08T12:00:00.000Z');

interface Seen {
  readonly path: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

const seen: Seen[] = [];
const base = 'https://push.example.test';

/**
 * The stub push service: a `fetch` that answers by path the way a real one answers by state. Not
 * a socket — the suite's network is sealed — but the sender hands it a real `Request`, so headers
 * and body are what would have gone on the wire.
 */
const pushService = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  const path = new URL(request.url).pathname;
  seen.push({ path, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
  if (path.startsWith('/gone-404')) return new Response(null, { status: 404 });
  if (path.startsWith('/gone')) return new Response(null, { status: 410 });
  if (path.startsWith('/busy'))
    return new Response(null, { status: 429, headers: { 'retry-after': '30' } });
  if (path.startsWith('/down')) return new Response(null, { status: 503 });
  if (path.startsWith('/wrong-key')) return new Response('invalid JWT provided', { status: 403 });
  return new Response(null, { status: 201 });
}) as typeof fetch;

afterEach(() => {
  seen.length = 0;
  resetWebPush();
});

/** A user agent: an ECDH pair and an auth secret, exactly what `PushSubscription.toJSON()` holds. */
async function userAgent(): Promise<{
  readonly keys: { readonly p256dh: string; readonly auth: string };
  decrypt(body: Uint8Array): Promise<string>;
}> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const hkdf = async (
    salt: Uint8Array<ArrayBuffer>,
    ikm: Uint8Array<ArrayBuffer>,
    info: string | Uint8Array<ArrayBuffer>,
    n: number,
  ): Promise<Uint8Array<ArrayBuffer>> => {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt,
        info: typeof info === 'string' ? new TextEncoder().encode(info) : info,
      },
      key,
      n * 8,
    );
    return new Uint8Array(bits);
  };
  return {
    keys: { p256dh: encodeBase64Url(uaPublic), auth: encodeBase64Url(auth) },
    async decrypt(body) {
      const salt = body.slice(0, 16);
      const asPublic = body.slice(21, 86);
      const asKey = await crypto.subtle.importKey(
        'raw',
        asPublic,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
      );
      const ecdh = new Uint8Array(
        await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, pair.privateKey, 256),
      );
      const info = new Uint8Array([
        ...new TextEncoder().encode('WebPush: info\0'),
        ...uaPublic,
        ...asPublic,
      ]);
      const ikm = await hkdf(auth, ecdh, info, 32);
      const cek = await hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
      const nonce = await hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12);
      const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      const plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(86)),
      );
      return new TextDecoder().decode(plain.slice(0, -1));
    },
  };
}

const codeOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('expected a refusal');
};

describe('unit · one message to one subscription', () => {
  test('201: encrypted for the subscriber, signed, and every RFC 8030 header present', async () => {
    const vapid = await generateVapidKeys();
    const ua = await userAgent();
    const outcome = await sendPushMessage({
      target: { endpoint: `${base}/push/abc`, keys: ua.keys },
      plaintext: new TextEncoder().encode('{"title":"Hi"}'),
      vapid: {
        keys: await importVapidKeys(vapid),
        publicKey: vapid.publicKey,
        subject: 'mailto:ops@example.com',
      },
      delivery: { ttlSeconds: 60, urgency: 'high', topic: 'post:1 comments' },
      clock: frozenClock(NOW),
      fetch: pushService,
    });
    expect(outcome).toEqual({ kind: 'delivered', status: 201 });
    const [request] = seen;
    if (request === undefined) return expect.unreachable('the push service saw no request');
    expect(request.headers.get('content-encoding')).toBe('aes128gcm');
    expect(request.headers.get('content-type')).toBe('application/octet-stream');
    expect(request.headers.get('ttl')).toBe('60');
    expect(request.headers.get('urgency')).toBe('high');
    // Any string becomes the 32 URL-safe characters the header admits — deterministically.
    expect(request.headers.get('topic')).toMatch(/^[\w-]{32}$/);
    expect(request.headers.get('authorization')).toMatch(
      new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`),
    );
    expect(await ua.decrypt(request.body)).toBe('{"title":"Hi"}');
  });

  test('defaults: a day of TTL, normal urgency, and no topic header', async () => {
    const vapid = await generateVapidKeys();
    const ua = await userAgent();
    await sendPushMessage({
      target: { endpoint: `${base}/push/def`, keys: ua.keys },
      plaintext: new Uint8Array(1),
      vapid: {
        keys: await importVapidKeys(vapid),
        publicKey: vapid.publicKey,
        subject: 'mailto:a@b.c',
      },
      fetch: pushService,
    });
    expect(seen[0]?.headers.get('ttl')).toBe('86400');
    expect(seen[0]?.headers.get('urgency')).toBe('normal');
    expect(seen[0]?.headers.has('topic')).toBe(false);
  });

  test('404 and 410 are GONE — an outcome, not an error', async () => {
    const vapid = await generateVapidKeys();
    const signer = {
      keys: await importVapidKeys(vapid),
      publicKey: vapid.publicKey,
      subject: 'mailto:a@b.c',
    };
    const ua = await userAgent();
    for (const [path, status] of [
      ['gone-404', 404],
      ['gone', 410],
    ] as const) {
      expect(
        await sendPushMessage({
          target: { endpoint: `${base}/${path}/x`, keys: ua.keys },
          plaintext: new Uint8Array(1),
          vapid: signer,
          fetch: pushService,
        }),
      ).toEqual({ kind: 'gone', status });
    }
  });

  test('429 is X_PWA_PUSH_FAILED carrying the stated Retry-After; 503 is too; 403 is REJECTED', async () => {
    const vapid = await generateVapidKeys();
    const signer = {
      keys: await importVapidKeys(vapid),
      publicKey: vapid.publicKey,
      subject: 'mailto:a@b.c',
    };
    const ua = await userAgent();
    const send = (path: string) => () =>
      sendPushMessage({
        target: { endpoint: `${base}/${path}/x`, keys: ua.keys },
        plaintext: new Uint8Array(1),
        vapid: signer,
        fetch: pushService,
      });
    const busy = (await codeOf(send('busy'))) as {
      code: string;
      retry: string;
      meta: Record<string, unknown>;
    };
    expect(busy.code).toBe('X_PWA_PUSH_FAILED');
    expect(busy.retry).toBe('retry-after');
    expect(busy.meta['retryAfterSeconds']).toBe(30);
    expect(((await codeOf(send('down'))) as { code: string }).code).toBe('X_PWA_PUSH_FAILED');
    const wrong = (await codeOf(send('wrong-key'))) as {
      code: string;
      retry: string;
      cause: string;
      fix: string;
    };
    expect(wrong.code).toBe('X_PWA_PUSH_REJECTED');
    expect(wrong.retry).toBe('terminal');
    expect(wrong.cause).toContain('invalid JWT provided');
    expect(wrong.fix).toContain('x vapid show');
  });

  test('a connection that never opens is retryable; an http endpoint off loopback is never dialled', async () => {
    const vapid = await generateVapidKeys();
    const signer = {
      keys: await importVapidKeys(vapid),
      publicKey: vapid.publicKey,
      subject: 'mailto:a@b.c',
    };
    const ua = await userAgent();
    const refused = (await codeOf(() =>
      sendPushMessage({
        target: { endpoint: 'https://push.example.test/x', keys: ua.keys },
        plaintext: new Uint8Array(1),
        vapid: signer,
        fetch: (() =>
          Promise.reject(new TypeError('connect ECONNREFUSED'))) as unknown as typeof fetch,
      }),
    )) as { code: string };
    expect(refused.code).toBe('X_PWA_PUSH_FAILED');
    const plain = (await codeOf(() =>
      sendPushMessage({
        target: { endpoint: 'http://push.example.test/x', keys: ua.keys },
        plaintext: new Uint8Array(1),
        vapid: signer,
        fetch: pushService,
      }),
    )) as { code: string };
    expect(plain.code).toBe('X_PWA_PUSH_SUBSCRIPTION_INVALID');
  });
});

describe('unit · one notification to every device of one person', () => {
  const catalogs: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    en: { 'push.title': 'New comment', 'push.body': '{who} replied' },
    de: { 'push.title': 'Neuer Kommentar', 'push.body': '{who} hat geantwortet' },
  };
  const translate =
    (locale: string): Translate =>
    (key, params) =>
      (catalogs[locale]?.[key] ?? `⟦${key}⟧`).replace(/\{(\w+)\}/g, (_, name: string) =>
        String(params?.[name] ?? ''),
      );

  const record = (
    endpoint: string,
    keys: { p256dh: string; auth: string },
    locale: string,
    actorId = 'ana',
  ): PushSubscriptionRecord => ({
    endpoint,
    keys,
    locale,
    timeZone: 'Europe/Berlin',
    actorId,
    createdAt: NOW.getTime(),
    expirationTime: null,
  });

  test('each device in its own locale; gone deleted; refused logged; a 429 retried AFTER the rest', async () => {
    const store = memoryPushSubscriptionStore();
    const [de, en, gone, wrong, busy] = await Promise.all([1, 2, 3, 4, 5].map(() => userAgent()));
    if (
      de === undefined ||
      en === undefined ||
      gone === undefined ||
      wrong === undefined ||
      busy === undefined
    )
      return expect.unreachable('five user agents');
    await store.save(record(`${base}/a-de`, de.keys, 'de'));
    await store.save(record(`${base}/b-en`, en.keys, 'en'));
    await store.save(record(`${base}/busy`, busy.keys, 'en'));
    await store.save(record(`${base}/gone`, gone.keys, 'en'));
    await store.save(record(`${base}/wrong-key`, wrong.keys, 'en'));
    await store.save(record(`${base}/someone-else`, en.keys, 'en', 'ben'));
    await installWebPush({
      store,
      keys: await generateVapidKeys(),
      subject: 'mailto:ops@example.com',
      translate,
      clock: frozenClock(NOW),
      fetch: pushService,
    });
    const notification = {
      titleKey: 'push.title',
      bodyKey: 'push.body',
      params: { who: 'Mira' },
      url: '/posts/1',
      tag: 'post:1',
    };
    const failed = (await codeOf(() => pushToActor('ana', notification))) as { code: string };
    expect(failed.code).toBe('X_PWA_PUSH_FAILED');
    // Every device was tried — the busy one did not hold the others back; ben's never was.
    expect(seen.map((request) => request.path)).toEqual([
      '/a-de',
      '/b-en',
      '/busy',
      '/gone',
      '/wrong-key',
    ]);
    const body = async (path: string, ua: typeof de): Promise<Record<string, unknown>> =>
      JSON.parse(
        await ua.decrypt(seen.find((request) => request.path === path)?.body ?? new Uint8Array()),
      );
    expect(await body('/a-de', de)).toMatchObject({
      title: 'Neuer Kommentar',
      body: 'Mira hat geantwortet',
      lang: 'de',
      tag: 'post:1',
      url: '/posts/1',
    });
    expect(await body('/b-en', en)).toMatchObject({
      title: 'New comment',
      body: 'Mira replied',
      lang: 'en',
    });
    expect((await store.listFor('ana')).map((row) => row.endpoint)).toEqual([
      `${base}/a-de`,
      `${base}/b-en`,
      `${base}/busy`,
      `${base}/wrong-key`,
    ]);
  });

  test('a clean run reports what it did, and an expired subscription is deleted unsent', async () => {
    const store = memoryPushSubscriptionStore();
    const ua = await userAgent();
    await store.save(record(`${base}/ok`, ua.keys, 'en'));
    await store.save({
      ...record(`${base}/old`, ua.keys, 'en'),
      expirationTime: NOW.getTime() - 1,
    });
    await installWebPush({
      store,
      keys: await generateVapidKeys(),
      subject: 'mailto:a@b.c',
      translate,
      clock: frozenClock(NOW),
      fetch: pushService,
    });
    expect(
      await pushToActor('ana', { titleKey: 'push.title', bodyKey: 'push.body', url: '/' }),
    ).toEqual({
      delivered: 1,
      removed: 1,
      refused: 0,
    });
    expect(seen.map((request) => request.path)).toEqual(['/ok']);
  });

  test('webPush() is the notify pusher: send({ to }) reaches that person, and with no runtime refuses by code', async () => {
    const pusher = webPush();
    const error = (await codeOf(() =>
      pusher.send({
        to: 'ana',
        message: { titleKey: 'a', bodyKey: 'b', url: '/' },
        signal: new AbortController().signal,
      }),
    )) as { code: string };
    expect(error.code).toBe('X_PWA_PUSH_UNCONFIGURED');
    const store = memoryPushSubscriptionStore();
    const ua = await userAgent();
    await store.save(record(`${base}/ok`, ua.keys, 'en'));
    await installWebPush({
      store,
      keys: await generateVapidKeys(),
      subject: 'mailto:a@b.c',
      translate,
      fetch: pushService,
    });
    await pusher.send({
      to: 'ana',
      message: { titleKey: 'push.title', bodyKey: 'push.body', url: '/' },
      signal: new AbortController().signal,
    });
    expect(seen).toHaveLength(1);
  });
});
