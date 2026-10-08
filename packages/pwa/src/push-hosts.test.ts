// The push sender dials only push services: the built-in four and what the app lists, each with its
// subdomains on a dot boundary — and an endpoint is checked when stored and before every send,
// because a hostname resolves wherever its owner points it.

import { describe, expect, test } from 'bun:test';
import { pushHostAllowed } from './push-hosts';
import { assertPushEndpoint, sendPushMessage } from './push-send';

const codeOf = (run: () => void): string | undefined => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('unit · the push-service allowlist', () => {
  test.each([
    ['https://fcm.googleapis.com/fcm/send/abc'],
    ['https://fcm.googleapis.com/wp/abc'],
    ['https://updates.push.services.mozilla.com/wpush/v2/abc'],
    ['https://web.push.apple.com/QGuBnbTEa0'],
    ['https://wns2-par02p.notify.windows.com/w/?token=abc'],
  ])('%p — a real push service — is dialled', (endpoint) => {
    expect(codeOf(() => assertPushEndpoint(endpoint))).toBeUndefined();
  });

  test.each([
    ['https://evil.com/push'],
    ['https://fcm.googleapis.com.evil.com/fcm/send/abc'],
    ['https://evilfcm.googleapis.com/fcm/send/abc'],
    ['https://push.apple.com.attacker.net/x'],
    ['https://notpush.apple.com/x'],
    ['https://googleapis.com/x'],
    ['https://internal.corp.example/x'],
  ])('%p is not a push service: X_PWA_PUSH_HOST_UNLISTED', (endpoint) => {
    expect(codeOf(() => assertPushEndpoint(endpoint))).toBe('X_PWA_PUSH_HOST_UNLISTED');
  });

  test.each([
    ['http://fcm.googleapis.com/fcm/send/abc'],
    ['https://127.0.0.1/x'],
    ['https://169.254.169.254/latest/meta-data'],
    ['https://[::1]/x'],
    ['https://localhost/x'],
    ['not a url'],
  ])('%p is refused before the list is asked', (endpoint) => {
    expect(codeOf(() => assertPushEndpoint(endpoint))).toBe('X_PWA_PUSH_SUBSCRIPTION_INVALID');
  });

  test('pwa.vapid.pushHosts extends the list — itself and its subdomains, nothing else', () => {
    const listed = ['push.example.com'];
    expect(codeOf(() => assertPushEndpoint('https://push.example.com/x', listed))).toBeUndefined();
    expect(
      codeOf(() => assertPushEndpoint('https://eu.push.example.com/x', listed)),
    ).toBeUndefined();
    expect(codeOf(() => assertPushEndpoint('https://push.example.com.evil.net/x', listed))).toBe(
      'X_PWA_PUSH_HOST_UNLISTED',
    );
    expect(codeOf(() => assertPushEndpoint('https://xpush.example.com/x', listed))).toBe(
      'X_PWA_PUSH_HOST_UNLISTED',
    );
    // Case and a trailing root dot are the same host.
    expect(pushHostAllowed('FCM.GoogleAPIs.com.')).toBe(true);
  });
});

test('the SENDER asks too: a refused endpoint is never dialled, whatever reached the store', async () => {
  const dialled: string[] = [];
  const fetch = (async (url: string) => {
    dialled.push(url);
    return new Response(null, { status: 201 });
  }) as unknown as typeof globalThis.fetch;
  for (const endpoint of [
    'http://127.0.0.1:9901/quitquitquit',
    'https://169.254.169.254/latest/meta-data',
    'https://metadata.attacker.example/x',
  ]) {
    const refused = await sendPushMessage({
      target: { endpoint, keys: { p256dh: 'x', auth: 'y' } },
      plaintext: new Uint8Array(1),
      vapid: undefined as never,
      fetch,
    }).then(
      () => undefined,
      (error: unknown) => (error as { code?: string }).code,
    );
    expect(refused).toStartWith('X_PWA_PUSH_');
  }
  expect(dialled).toEqual([]);
});
