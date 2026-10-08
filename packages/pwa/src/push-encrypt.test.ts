// RFC 8291 against its own Appendix A: every intermediate value the RFC prints, then the body of
// Section 5 byte for byte. A wrong HKDF label, a missing 0x02 delimiter or a record size in the
// wrong byte order each change the body, so a green run here is the wire format, not a round trip
// through our own code.

import { describe, expect, test } from 'bun:test';
import { encodeBase64Url, tryDecodeBase64Url } from './push-bytes';
import {
  deriveContentKeys,
  encryptPushMessage,
  PUSH_RECORD_SIZE,
  pushMessageCapacity,
} from './push-encrypt';
import { importVapidKeys } from './vapid';

// RFC 8291 Appendix A, verbatim (whitespace removed).
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
} as const;

/** The application server's ephemeral pair from the RFC — injected where production rolls one. */
const rfcEphemeral = async (): Promise<CryptoKeyPair> => {
  const keys = await importVapidKeys(
    { publicKey: RFC.asPublic, privateKey: RFC.asPrivate },
    'ECDH',
  );
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
};

/** A constant this file wrote: decoding it cannot fail, and the guard says so if it ever does. */
function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const bytes = tryDecodeBase64Url(text);
  if (bytes === undefined) return expect.unreachable(`not base64url: ${text}`);
  return bytes;
}

const subscription = { p256dh: RFC.uaPublic, auth: RFC.authSecret };

describe('unit · RFC 8291 Appendix A', () => {
  test('the key schedule reproduces every intermediate value the RFC prints', async () => {
    const derived = await deriveContentKeys({
      ephemeral: await rfcEphemeral(),
      uaPublic: decodeBase64Url(RFC.uaPublic),
      authSecret: decodeBase64Url(RFC.authSecret),
      salt: decodeBase64Url(RFC.salt),
    });
    expect(encodeBase64Url(derived.ecdhSecret)).toBe(RFC.ecdhSecret);
    expect(encodeBase64Url(derived.ikm)).toBe(RFC.ikm);
    expect(encodeBase64Url(derived.cek)).toBe(RFC.cek);
    expect(encodeBase64Url(derived.nonce)).toBe(RFC.nonce);
  });

  test('the body is Section 5 byte for byte: 86-octet header, then the ciphertext', async () => {
    const body = await encryptPushMessage(subscription, decodeBase64Url(RFC.plaintext), {
      ephemeral: await rfcEphemeral(),
      salt: decodeBase64Url(RFC.salt),
    });
    // 86 + 41 + 1 + 16. Section 5 prints `Content-Length: 145`, one more than its own body decodes to
    // — the body below is the RFC's own bytes, and they decode to 144.
    expect(body.byteLength).toBe(144);
    expect(encodeBase64Url(body.slice(0, 86))).toBe(RFC.header);
    expect(encodeBase64Url(body)).toBe(RFC.body);
  });

  test('a fresh salt and key per message: two encryptions of one plaintext never share bytes', async () => {
    const plaintext = new TextEncoder().encode('same');
    const a = await encryptPushMessage(subscription, plaintext);
    const b = await encryptPushMessage(subscription, plaintext);
    expect(encodeBase64Url(a.slice(0, 16))).not.toBe(encodeBase64Url(b.slice(0, 16)));
    expect(encodeBase64Url(a.slice(21, 86))).not.toBe(encodeBase64Url(b.slice(21, 86)));
  });

  test('the user agent decrypts what we send — the receiver half, run against our output', async () => {
    const plaintext = new TextEncoder().encode('{"title":"Hallo","body":"Welt"}');
    const body = await encryptPushMessage(subscription, plaintext);
    expect(new TextDecoder().decode(await receiverDecrypt(body))).toBe(
      '{"title":"Hallo","body":"Welt"}',
    );
  });

  test('one record: a plaintext past the capacity is refused, never split', async () => {
    expect(pushMessageCapacity()).toBe(PUSH_RECORD_SIZE - 86 - 16 - 1);
    const big = new Uint8Array(pushMessageCapacity() + 1);
    try {
      await encryptPushMessage(subscription, big);
      expect.unreachable('a plaintext past one record must be refused');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('X_PWA_PUSH_PAYLOAD_TOO_LARGE');
    }
    const fits = await encryptPushMessage(subscription, new Uint8Array(pushMessageCapacity()));
    expect(fits.byteLength).toBe(PUSH_RECORD_SIZE);
  });

  test('a subscription key that is not an uncompressed P-256 point is refused by code', async () => {
    try {
      await encryptPushMessage({ p256dh: 'AAAA', auth: RFC.authSecret }, new Uint8Array(1));
      expect.unreachable('a malformed p256dh must be refused');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('X_PWA_PUSH_SUBSCRIPTION_INVALID');
    }
  });
});

/**
 * RFC 8291 Section 3.4 from the user agent's side, written here and not imported: a decryptor in
 * the package would be code no caller runs. Same schedule, mirrored — ECDH(ua_private, as_public).
 */
async function receiverDecrypt(body: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const asPublic = body.slice(21, 86);
  const ua = await importVapidKeys({ publicKey: RFC.uaPublic, privateKey: RFC.uaPrivate }, 'ECDH');
  const asKey = await crypto.subtle.importKey(
    'raw',
    asPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256),
  );
  const hkdf = async (
    salt: Uint8Array<ArrayBuffer>,
    ikm: Uint8Array<ArrayBuffer>,
    info: Uint8Array<ArrayBuffer>,
    bytes: number,
  ): Promise<Uint8Array<ArrayBuffer>> => {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8),
    );
  };
  const text = new TextEncoder();
  const keyInfo = new Uint8Array([
    ...text.encode('WebPush: info\0'),
    ...decodeBase64Url(RFC.uaPublic),
    ...asPublic,
  ]);
  const ikm = await hkdf(decodeBase64Url(RFC.authSecret), ecdh, keyInfo, 32);
  const cek = await hkdf(salt, ikm, text.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, text.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(86)),
  );
  expect(padded.at(-1)).toBe(2);
  return padded.slice(0, -1);
}
