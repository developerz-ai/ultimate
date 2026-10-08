// Single responsibility: RFC 8291 from the USER AGENT's side — open one `aes128gcm` push record
// with the subscriber's private key and auth secret. A browser does this itself; the framework's
// caller is `@ultimat3/testing`'s `push` fixture, which plays the browser so a test asserts the
// notification a device would show rather than the bytes a push service received.

import { PwaPushSubscriptionInvalidError } from './errors';
import { concatBytes } from './push-bytes';

/** A subscriber: its ECDH key pair (the private half never leaves it) and its auth secret. */
export interface PushReceiverKeys {
  readonly privateKey: CryptoKey;
  /** The 65-byte uncompressed point the subscription's `p256dh` carries. */
  readonly publicKey: Uint8Array<ArrayBuffer>;
  /** The 16 bytes the subscription's `auth` carries. */
  readonly authSecret: Uint8Array<ArrayBuffer>;
}

const text = new TextEncoder();

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8),
  );
}

/**
 * The plaintext of one record, delimiter stripped. A body that is not one well-formed record for
 * these keys — truncated, another subscriber's, tampered — is refused by code, as a browser drops it.
 */
export async function decryptPushMessage(
  body: Uint8Array<ArrayBuffer>,
  receiver: PushReceiverKeys,
): Promise<Uint8Array<ArrayBuffer>> {
  const idLength = body[20] ?? 0;
  if (body.byteLength < 21 + idLength + 17 || idLength !== 65) {
    throw new PwaPushSubscriptionInvalidError({
      field: 'body',
      reason: 'is not one aes128gcm record with a 65-byte sender key',
    });
  }
  const opened = await open(body, receiver, idLength);
  if (opened === undefined) {
    throw new PwaPushSubscriptionInvalidError({
      field: 'body',
      reason: 'does not open with these keys: another subscriber’s, truncated or tampered',
    });
  }
  return opened;
}

/** The record's plaintext, or `undefined` for every way it fails to be one for these keys. */
async function open(
  body: Uint8Array<ArrayBuffer>,
  receiver: PushReceiverKeys,
  idLength: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const salt = body.slice(0, 16);
  const asPublic = body.slice(21, 21 + idLength);
  let padded: Uint8Array<ArrayBuffer>;
  try {
    const asKey = await crypto.subtle.importKey(
      'raw',
      asPublic,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const ecdh = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, receiver.privateKey, 256),
    );
    const keyInfo = concatBytes(text.encode('WebPush: info\0'), receiver.publicKey, asPublic);
    const ikm = await hkdf(receiver.authSecret, ecdh, keyInfo, 32);
    const cek = await hkdf(salt, ikm, text.encode('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(salt, ikm, text.encode('Content-Encoding: nonce\0'), 12);
    const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    padded = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idLength)),
    );
  } catch {
    return undefined;
  }
  // RFC 8188: strip zero padding back to the delimiter; 0x02 marks the last (only) record.
  let end = padded.byteLength - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  return padded[end] === 2 ? padded.slice(0, end) : undefined;
}
