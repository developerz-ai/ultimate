// End to end, minus the browser's push transport: a notification sent with `pushToActor` is
// encrypted, POSTed, decrypted by the subscriber's keys, and handed to the push listener of the
// WHOLE emitted `sw.js` (`generateServiceWorker` with push and a VAPID key, as the web role builds
// it) — which shows it in the subscriber's language with its tag, and opens its URL on a tap.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { Translate } from './push';
import { encodeBase64Url } from './push-bytes';
import { installWebPush, resetWebPush } from './push-runtime';
import { memoryPushSubscriptionStore } from './push-store';
import { generateServiceWorker } from './service-worker';
import { DEV_VAPID_KEYS } from './vapid-keys';
import { pushToActor } from './web-push';

const ORIGIN = 'https://app.test';

afterEach(() => resetWebPush());

/** The emitted worker in a realm with the push surface a browser gives it. */
function worker(source: string) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      void listeners.set(type, listener),
    clients: { claim: async () => undefined, matchAll: async () => [] },
    skipWaiting: async () => undefined,
    registration: {
      navigationPreload: { enable: async () => undefined },
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
    },
  };
  const clients = {
    matchAll: async () => [],
    openWindow: async (url: string) => void opened.push(url),
  };
  const factory = new Function(
    'self',
    'caches',
    'fetch',
    'Request',
    'clients',
    'navigator',
    source,
  ) as (...args: unknown[]) => void;
  factory(self, {}, fetch, Request, clients, {});
  const fire = async (type: string, event: Record<string, unknown>) => {
    let work: unknown;
    listeners.get(type)?.({
      ...event,
      waitUntil: (p: unknown) => {
        work = p;
      },
    });
    await work;
  };
  return { shown, opened, listeners, fire };
}

async function userAgent() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const hkdf = async (
    salt: Uint8Array<ArrayBuffer>,
    ikm: Uint8Array<ArrayBuffer>,
    info: Uint8Array<ArrayBuffer>,
    n: number,
  ) => {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, n * 8),
    );
  };
  const text = new TextEncoder();
  return {
    keys: { p256dh: encodeBase64Url(uaPublic), auth: encodeBase64Url(auth) },
    /** What the browser's push service hands the worker: the decrypted record. */
    async open(body: Uint8Array<ArrayBuffer>): Promise<string> {
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
      const ikm = await hkdf(
        auth,
        ecdh,
        new Uint8Array([...text.encode('WebPush: info\0'), ...uaPublic, ...asPublic]),
        32,
      );
      const cek = await hkdf(salt, ikm, text.encode('Content-Encoding: aes128gcm\0'), 16);
      const nonce = await hkdf(salt, ikm, text.encode('Content-Encoding: nonce\0'), 12);
      const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      const plain = new Uint8Array(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(86)),
      );
      return new TextDecoder().decode(plain.slice(0, -1));
    },
  };
}

const catalog: Readonly<Record<string, string>> = {
  'push.comment.title': 'Neuer Kommentar',
  'push.comment.body': '{who} hat auf „{post}“ geantwortet',
};
const translate =
  (_locale: string): Translate =>
  (key, params) =>
    (catalog[key] ?? `⟦${key}⟧`).replace(/\{(\w+)\}/g, (_, name: string) =>
      String(params?.[name] ?? ''),
    );

describe('integration · a push, from pushToActor to the device', () => {
  test('sent, decrypted, shown by the emitted sw.js in German with its tag, and opened on a tap', async () => {
    const { source } = generateServiceWorker(
      [],
      {
        offline: { fallback: '/offline' },
        capabilities: { push: true, backgroundSync: false, badging: false },
        vapid: { publicKey: DEV_VAPID_KEYS.publicKey, subject: 'mailto:ops@example.test' },
      },
      'build-1',
    );
    const sw = worker(source);
    expect(sw.listeners.has('push')).toBe(true);

    const ua = await userAgent();
    const delivered: Uint8Array<ArrayBuffer>[] = [];
    const store = memoryPushSubscriptionStore();
    await store.save({
      endpoint: 'https://push.example.test/send/1',
      keys: ua.keys,
      locale: 'de',
      timeZone: 'Europe/Berlin',
      actorId: 'ana',
      createdAt: 0,
      expirationTime: null,
    });
    await installWebPush({
      pushHosts: ['push.example.test'],
      store,
      keys: DEV_VAPID_KEYS,
      subject: 'mailto:ops@example.test',
      translate,
      clock: frozenClock(new Date('2026-10-08T12:00:00Z')),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        delivered.push(new Uint8Array(await new Request(input, init).arrayBuffer()));
        return new Response(null, { status: 201 });
      }) as typeof fetch,
    });

    expect(
      await pushToActor('ana', {
        titleKey: 'push.comment.title',
        bodyKey: 'push.comment.body',
        params: { who: 'Mira', post: 'Hallo' },
        url: '/posts/1#c9',
        tag: 'post:1',
        renotify: true,
      }),
    ).toEqual({ delivered: 1, removed: 0, refused: 0 });

    const [body] = delivered;
    if (body === undefined) return expect.unreachable('nothing reached the push service');
    const plaintext = await ua.open(body);
    await sw.fire('push', { data: { json: () => JSON.parse(plaintext), text: () => plaintext } });
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]?.title).toBe('Neuer Kommentar');
    expect(sw.shown[0]?.options).toMatchObject({
      body: 'Mira hat auf „Hallo“ geantwortet',
      tag: 'post:1',
      renotify: true,
      lang: 'de',
      data: { url: '/posts/1#c9' },
    });

    await sw.fire('notificationclick', {
      notification: { close: () => undefined, data: sw.shown[0]?.options['data'] },
    });
    expect(sw.opened).toEqual([`${ORIGIN}/posts/1#c9`]);
  });
});
