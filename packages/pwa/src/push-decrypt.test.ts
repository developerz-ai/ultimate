// The receiving half against the sending half and against RFC 8291 Appendix A: what
// `encryptPushMessage` seals, `decryptPushMessage` opens with the subscriber's keys — and a body
// for another subscriber, or one byte tampered, is refused by code rather than opened as garbage.

import { describe, expect, test } from 'bun:test';
import { encodeBase64Url, tryDecodeBase64Url } from './push-bytes';
import type { PushReceiverKeys } from './push-decrypt';
import { decryptPushMessage } from './push-decrypt';
import { encryptPushMessage } from './push-encrypt';
import { importVapidKeys } from './vapid';

const bytes = (text: string): Uint8Array<ArrayBuffer> =>
  tryDecodeBase64Url(text) ?? expect.unreachable(`not base64url: ${text}`);

async function receiver(): Promise<{
  readonly keys: PushReceiverKeys;
  readonly subscription: { readonly p256dh: string; readonly auth: string };
}> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    keys: { privateKey: pair.privateKey, publicKey, authSecret },
    subscription: { p256dh: encodeBase64Url(publicKey), auth: encodeBase64Url(authSecret) },
  };
}

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return expect.unreachable('expected a refusal');
};

describe('unit · decryptPushMessage', () => {
  test('opens RFC 8291 Section 5’s body with the RFC’s user-agent keys', async () => {
    const ua = await importVapidKeys(
      {
        publicKey:
          'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        privateKey: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
      },
      'ECDH',
    );
    const plain = await decryptPushMessage(
      bytes(
        'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
      ),
      {
        privateKey: ua.privateKey,
        publicKey: bytes(
          'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        ),
        authSecret: bytes('BTBZMqHH6r4Tts7J_aSIgg'),
      },
    );
    expect(new TextDecoder().decode(plain)).toBe('When I grow up, I want to be a watermelon');
  });

  test('round-trips what the sender seals', async () => {
    const ana = await receiver();
    const body = await encryptPushMessage(ana.subscription, new TextEncoder().encode('hola'));
    expect(new TextDecoder().decode(await decryptPushMessage(body, ana.keys))).toBe('hola');
  });

  test('another subscriber’s body, a tampered byte, or a truncated record is refused', async () => {
    const ana = await receiver();
    const ben = await receiver();
    const body = await encryptPushMessage(ana.subscription, new TextEncoder().encode('hola'));
    expect(await codeOf(() => decryptPushMessage(body, ben.keys))).toBe(
      'X_PWA_PUSH_SUBSCRIPTION_INVALID',
    );
    const tampered = body.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(await codeOf(() => decryptPushMessage(tampered, ana.keys))).toBe(
      'X_PWA_PUSH_SUBSCRIPTION_INVALID',
    );
    expect(await codeOf(() => decryptPushMessage(body.slice(0, 40), ana.keys))).toBe(
      'X_PWA_PUSH_SUBSCRIPTION_INVALID',
    );
  });
});
