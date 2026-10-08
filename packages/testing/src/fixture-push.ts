// The `push` fixture: a Web Push runtime for one test, with the push service AND the device played
// in-process. `push.subscribe(actorId)` gives that person a browser — a real P-256 key and auth
// secret, as `PushSubscription.toJSON()` carries — and `push.sent()` is what each device would SHOW:
// every delivery decrypted with that browser's own key, so a test asserts the notification, not
// the bytes. Nothing reaches the network.

import type { PushReceiverKeys } from '@ultimat3/pwa';

/** One delivery, as the device received it. */
export interface TestPushMessage {
  readonly actorId: string;
  readonly endpoint: string;
  /** The push service's request headers: `ttl`, `urgency`, `topic`, `authorization`. */
  readonly headers: Readonly<Record<string, string>>;
  /** The notification the worker would show — `serializePushMessage`'s fields, decrypted. */
  readonly notification: Readonly<Record<string, unknown>>;
}

/** `Disposable`: the fixture installs the process's push runtime and releases it after the test. */
export interface TestPush extends Disposable {
  /** A browser for `actorId`, subscribed in `locale` (default `en`); answers its endpoint. */
  subscribe(
    actorId: string,
    options?: { readonly locale?: string; readonly timeZone?: string },
  ): Promise<string>;
  /** Oldest first. */
  sent(): readonly TestPushMessage[];
  /** The push service answers the next request `status`: 410 deletes it, 429 makes the job retry. */
  answerOnce(status: number): void;
  clear(): void;
}

const PUSH_SERVICE = 'https://push.test';

export async function testPush(): Promise<TestPush> {
  const pwa = await import('@ultimat3/pwa');
  const store = pwa.memoryPushSubscriptionStore();
  const devices = new Map<string, { readonly actorId: string; readonly keys: PushReceiverKeys }>();
  const sent: TestPushMessage[] = [];
  const answers: number[] = [];
  let counter = 0;

  const pushService = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const answer = answers.shift() ?? 201;
    const device = devices.get(request.url);
    if (answer >= 200 && answer < 300 && device !== undefined) {
      const body = new Uint8Array(await request.arrayBuffer());
      const plain = await pwa.decryptPushMessage(body, device.keys);
      sent.push({
        actorId: device.actorId,
        endpoint: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        notification: JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>,
      });
    }
    return new Response(null, { status: answer });
  }) as typeof fetch;

  const release = await pwa.installWebPush({
    store,
    keys: pwa.DEV_VAPID_KEYS,
    subject: 'mailto:push@example.test',
    fetch: pushService,
  });

  return {
    async subscribe(actorId, options) {
      counter += 1;
      const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
        'deriveBits',
      ]);
      const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
      // why: a browser rolls its auth secret; this stands in for one, and pins nothing a test reads.
      const authSecret = crypto.getRandomValues(new Uint8Array(16));
      const endpoint = `${PUSH_SERVICE}/device/${counter}`;
      devices.set(endpoint, {
        actorId,
        keys: { privateKey: pair.privateKey, publicKey, authSecret },
      });
      const base64url = (bytes: Uint8Array): string =>
        btoa(String.fromCharCode(...bytes))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replaceAll('=', '');
      await store.save({
        endpoint,
        keys: { p256dh: base64url(publicKey), auth: base64url(authSecret) },
        locale: options?.locale ?? 'en',
        timeZone: options?.timeZone ?? 'UTC',
        actorId,
        createdAt: 0,
        expirationTime: null,
      });
      return endpoint;
    },
    sent: () => [...sent],
    answerOnce: (status) => {
      answers.push(status);
    },
    clear: () => {
      sent.length = 0;
      answers.length = 0;
    },
    [Symbol.dispose]: release,
  };
}
