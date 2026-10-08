// Single responsibility: RFC 8291 — encrypt one push message for one subscription, as a single
// `aes128gcm` record (RFC 8188). WebCrypto only: ECDH P-256 for the shared secret, HKDF-SHA-256
// for the key schedule, AES-128-GCM for the record.
//
// RANDOMNESS IS THE POINT HERE, and it is injectable. Each message needs a fresh salt and a fresh
// ephemeral key pair — reusing either across messages to one subscription reuses a GCM nonce under
// one key. Production rolls both; a test hands in RFC 8291 Appendix A's, and gets its exact bytes.

import { PwaPushPayloadTooLargeError, PwaPushSubscriptionInvalidError } from './errors';
import { concatBytes, tryDecodeBase64Url } from './push-bytes';

/** The one record size this encoder writes: the whole message is one record (RFC 8291 §4). */
export const PUSH_RECORD_SIZE = 4096;

/** salt(16) + rs(4) + idlen(1) + keyid(65): the `aes128gcm` header with the sender's public key. */
const HEADER_BYTES = 86;
const TAG_BYTES = 16;
/** RFC 8188's last-record delimiter, appended to the plaintext before it is sealed. */
const LAST_RECORD = 0x02;

/** Plaintext bytes one record holds: 4096 − 86 − 16 − 1 = 3993, RFC 8291 §4's number. */
export const pushMessageCapacity = (): number => PUSH_RECORD_SIZE - HEADER_BYTES - TAG_BYTES - 1;

/** What a browser's `PushSubscription.toJSON().keys` carries. */
export interface PushEncryptionKeys {
  /** The user agent's ECDH public key: 65-byte uncompressed P-256 point, base64url. */
  readonly p256dh: string;
  /** The 16-byte authentication secret, base64url. */
  readonly auth: string;
}

export interface PushEncryptOptions {
  /** The application server's ONE-MESSAGE key pair (ECDH). Rolled per message when omitted. */
  readonly ephemeral?: CryptoKeyPair | undefined;
  /** 16 bytes. Rolled per message when omitted. */
  readonly salt?: Uint8Array<ArrayBuffer> | undefined;
}

export interface ContentKeys {
  readonly ecdhSecret: Uint8Array<ArrayBuffer>;
  readonly ikm: Uint8Array<ArrayBuffer>;
  readonly cek: Uint8Array<ArrayBuffer>;
  readonly nonce: Uint8Array<ArrayBuffer>;
  /** The sender's public key as the header's `keyid` carries it. */
  readonly asPublic: Uint8Array<ArrayBuffer>;
}

const text = new TextEncoder();

/** HKDF-Extract then HKDF-Expand in one WebCrypto call — exactly RFC 5869's two steps. */
async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/** RFC 8291 §3.3–3.4 and RFC 8188 §2.2: the shared secret, then CEK and NONCE. */
export async function deriveContentKeys(input: {
  readonly ephemeral: CryptoKeyPair;
  readonly uaPublic: Uint8Array<ArrayBuffer>;
  readonly authSecret: Uint8Array<ArrayBuffer>;
  readonly salt: Uint8Array<ArrayBuffer>;
}): Promise<ContentKeys> {
  const uaKey = await crypto.subtle.importKey(
    'raw',
    input.uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: uaKey },
      input.ephemeral.privateKey,
      256,
    ),
  );
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', input.ephemeral.publicKey));
  const keyInfo = concatBytes(text.encode('WebPush: info\0'), input.uaPublic, asPublic);
  const ikm = await hkdf(input.authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(input.salt, ikm, text.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(input.salt, ikm, text.encode('Content-Encoding: nonce\0'), 12);
  return { ecdhSecret, ikm, cek, nonce, asPublic };
}

/** The subscription's two keys, decoded and size-checked, or the refusal naming which one. */
export function subscriptionKeyBytes(keys: PushEncryptionKeys): {
  readonly uaPublic: Uint8Array<ArrayBuffer>;
  readonly authSecret: Uint8Array<ArrayBuffer>;
} {
  const uaPublic = tryDecodeBase64Url(keys.p256dh);
  if (uaPublic === undefined || uaPublic.byteLength !== 65 || uaPublic[0] !== 4) {
    throw new PwaPushSubscriptionInvalidError({
      field: 'keys.p256dh',
      reason: 'is not a 65-byte uncompressed P-256 point in base64url',
    });
  }
  const authSecret = tryDecodeBase64Url(keys.auth);
  if (authSecret === undefined || authSecret.byteLength !== 16) {
    throw new PwaPushSubscriptionInvalidError({
      field: 'keys.auth',
      reason: 'is not a 16-byte secret in base64url',
    });
  }
  return { uaPublic, authSecret };
}

/**
 * The request body: `salt | rs | idlen | keyid | ciphertext`. One record, so the plaintext gets
 * the LAST-record delimiter and no padding — padding hides a length, and every message here is a
 * notification the device shows in full.
 */
export async function encryptPushMessage(
  keys: PushEncryptionKeys,
  plaintext: Uint8Array,
  options: PushEncryptOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const capacity = pushMessageCapacity();
  if (plaintext.byteLength > capacity) {
    throw new PwaPushPayloadTooLargeError({ bytes: plaintext.byteLength, limit: capacity });
  }
  const { uaPublic, authSecret } = subscriptionKeyBytes(keys);
  // why: the salt and the one-message key ARE randomness by specification (RFC 8291 §3.3); the
  // options above are the seam a test pins them through.
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const ephemeral =
    options.ephemeral ??
    (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  let derived: ContentKeys;
  try {
    derived = await deriveContentKeys({ ephemeral, uaPublic, authSecret, salt });
  } catch {
    // A 65-byte string starting 0x04 that is not ON the curve: WebCrypto refuses the import.
    throw new PwaPushSubscriptionInvalidError({
      field: 'keys.p256dh',
      reason: 'is not a point on the P-256 curve',
    });
  }
  const key = await crypto.subtle.importKey('raw', derived.cek, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: derived.nonce },
      key,
      concatBytes(plaintext, Uint8Array.of(LAST_RECORD)),
    ),
  );
  const header = new Uint8Array(HEADER_BYTES - 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, PUSH_RECORD_SIZE, false);
  header[20] = derived.asPublic.byteLength;
  return concatBytes(header, derived.asPublic, sealed);
}
