// One POST to one push service has a deadline, so a service that accepts and never answers cannot
// hold the rest of a fan-out; and a caller's own abort is rethrown as is — never the retryable
// `X_PWA_PUSH_FAILED`, which would re-deliver to every device already served.

import { expect, test } from 'bun:test';
import { sendPushMessage } from './push-send';
import { generateVapidKeys, importVapidKeys } from './vapid';

/** A browser's subscription keys: an ECDH P-256 public key and a 16-byte auth secret. */
async function subscriberKeys(): Promise<{ readonly p256dh: string; readonly auth: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const b64url = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
  return { p256dh: b64url(raw), auth: b64url(crypto.getRandomValues(new Uint8Array(16))) };
}

test('every POST carries a deadline, and a caller that cancels is not a retryable fault', async () => {
  const vapid = await generateVapidKeys();
  let signal: AbortSignal | null | undefined;
  const hung = ((_url: string, init?: RequestInit) => {
    signal = init?.signal;
    return new Promise<Response>((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
    );
  }) as unknown as typeof fetch;
  const caller = new AbortController();
  const sending = sendPushMessage({
    pushHosts: ['push.example.test'],
    target: { endpoint: 'https://push.example.test/hangs', keys: await subscriberKeys() },
    plaintext: new Uint8Array(1),
    vapid: {
      keys: await importVapidKeys(vapid),
      publicKey: vapid.publicKey,
      subject: 'mailto:a@b.c',
    },
    fetch: hung,
    signal: caller.signal,
  }).then(
    () => expect.unreachable('a hung send resolved'),
    (error: unknown) => error,
  );
  await Bun.sleep(5);
  expect(signal).toBeInstanceOf(AbortSignal);
  // Not the caller's signal itself: the deadline is combined with it.
  expect(signal).not.toBe(caller.signal);
  caller.abort(new DOMException('cancelled', 'AbortError'));
  const thrown = await sending;
  expect(thrown).toBeInstanceOf(DOMException);
  expect((thrown as DOMException).name).toBe('AbortError');
});
