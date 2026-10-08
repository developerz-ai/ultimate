// Single responsibility: the application server's identity to a push service — RFC 8292 VAPID.
// A P-256 key pair, and the ES256 JWT that proves this server holds the private half of the key a
// subscription was made with. WebCrypto only: no `jose`, no `web-push` (docs/idea/18-build-vs-wrap.md
// — the whole of RFC 8292 is one signature over two JSON objects).
//
// Keys travel as the format every push library prints: the public key as the 65-byte uncompressed
// point and the private key as the 32-byte scalar, both unpadded base64url. A key pair minted by
// `web-push generate-vapid-keys` therefore works here unchanged.

import type { Clock } from '@ultimat3/core';
import { systemClock } from '@ultimat3/core';
import { PwaVapidKeyInvalidError } from './errors';
import { encodeBase64Url, tryDecodeBase64Url } from './push-bytes';

/** The pair as configuration holds it: two base64url strings. */
export interface VapidKeyPair {
  /** 65-byte uncompressed P-256 point, base64url — what a browser's `applicationServerKey` takes. */
  readonly publicKey: string;
  /** 32-byte P-256 scalar, base64url. A secret: `ULTIMATE_VAPID_PRIVATE_KEY`. */
  readonly privateKey: string;
}

/** The env var each half is read from — the names `x vapid create` seals and the boot reads. */
export const VAPID_PUBLIC_KEY_ENV = 'ULTIMATE_VAPID_PUBLIC_KEY';
export const VAPID_PRIVATE_KEY_ENV = 'ULTIMATE_VAPID_PRIVATE_KEY';

/**
 * RFC 8292 §2: `exp` no more than 24 hours ahead. Twelve, because a push service compares it with
 * its own clock, and a server whose clock runs ahead by minutes must not produce a token the
 * service reads as 24 hours and one minute.
 */
export const VAPID_TOKEN_TTL_SECONDS = 12 * 60 * 60;

const P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/** The 65-byte point, or the refusal naming which key and why. */
export function vapidPublicKeyBytes(
  publicKey: string,
  key = VAPID_PUBLIC_KEY_ENV,
): Uint8Array<ArrayBuffer> {
  const bytes = tryDecodeBase64Url(publicKey);
  if (bytes === undefined || bytes.byteLength !== 65 || bytes[0] !== 4) {
    throw new PwaVapidKeyInvalidError({
      key,
      reason: 'is not a 65-byte uncompressed P-256 point in base64url (87 characters, starting B)',
    });
  }
  return bytes;
}

/**
 * Import the pair for ECDSA (signing a VAPID token) or ECDH (RFC 8291's key agreement — the same
 * import, so a test can hand the RFC's application-server pair to the encryptor).
 *
 * JWK because WebCrypto has no raw-scalar import: `d` is the private key, `x`/`y` the public point.
 * WebCrypto does NOT check that `d` belongs to `x`/`y`, so a mismatched pair imports fine and signs
 * tokens no push service will verify — `assertVapidPair` is the check, run once at boot.
 */
export async function importVapidKeys(
  pair: VapidKeyPair,
  algorithm: 'ECDSA' | 'ECDH' = 'ECDSA',
): Promise<CryptoKeyPair> {
  const point = vapidPublicKeyBytes(pair.publicKey);
  const scalar = tryDecodeBase64Url(pair.privateKey);
  if (scalar === undefined || scalar.byteLength !== 32) {
    throw new PwaVapidKeyInvalidError({
      key: VAPID_PRIVATE_KEY_ENV,
      reason: 'is not a 32-byte P-256 scalar in base64url (43 characters)',
    });
  }
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: encodeBase64Url(point.slice(1, 33)),
    y: encodeBase64Url(point.slice(33, 65)),
    ext: true,
  };
  const params = { name: algorithm, namedCurve: 'P-256' } as const;
  const usages: KeyUsage[] = algorithm === 'ECDSA' ? ['sign'] : ['deriveBits'];
  try {
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      { ...jwk, d: encodeBase64Url(scalar) },
      params,
      false,
      usages,
    );
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      params,
      true,
      algorithm === 'ECDSA' ? ['verify'] : [],
    );
    return { privateKey, publicKey };
  } catch {
    throw new PwaVapidKeyInvalidError({
      key: VAPID_PUBLIC_KEY_ENV,
      reason: 'is not a point on the P-256 curve',
    });
  }
}

/**
 * Sign once with the private half and verify with the public half. The only way to learn that two
 * strings someone pasted into two variables are one key pair, and a wrong pair is otherwise a 403
 * from every push service on every send, discovered by a user who never got a notification.
 */
export async function assertVapidPair(pair: VapidKeyPair): Promise<void> {
  const keys = await importVapidKeys(pair);
  const probe = new TextEncoder().encode('ultimate vapid pair check');
  const signature = await crypto.subtle.sign({ ...P256, hash: 'SHA-256' }, keys.privateKey, probe);
  const ok = await crypto.subtle.verify(
    { ...P256, hash: 'SHA-256' },
    keys.publicKey,
    signature,
    probe,
  );
  if (!ok) {
    throw new PwaVapidKeyInvalidError({
      key: VAPID_PRIVATE_KEY_ENV,
      reason: `does not sign for ${VAPID_PUBLIC_KEY_ENV}: the two halves are from different pairs`,
    });
  }
}

/** A fresh pair, for `x vapid create`. The one place in this package that rolls key material. */
export async function generateVapidKeys(): Promise<VapidKeyPair> {
  const pair = await crypto.subtle.generateKey(P256, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: encodeBase64Url(raw), privateKey: jwk.d ?? '' };
}

export interface VapidTokenInput {
  /** The subscription's endpoint; the token's audience is its ORIGIN, never the full URL. */
  readonly endpoint: string;
  /** `mailto:` or `https:` — who the push service writes to about this server. */
  readonly subject: string;
  readonly keys: CryptoKeyPair;
  readonly publicKey: string;
  readonly clock?: Clock | undefined;
}

/**
 * The `Authorization` header value: `vapid t=<jwt>, k=<public key>` (RFC 8292 §3). The signature is
 * WebCrypto's raw `r || s`, which is exactly JWS ES256's encoding — no DER to unwrap.
 */
export async function vapidAuthorization(input: VapidTokenInput): Promise<string> {
  const clock = input.clock ?? systemClock;
  const exp = Math.floor(clock.now().getTime() / 1000) + VAPID_TOKEN_TTL_SECONDS;
  const text = new TextEncoder();
  const segment = (value: object): string => encodeBase64Url(text.encode(JSON.stringify(value)));
  const unsigned = `${segment({ typ: 'JWT', alg: 'ES256' })}.${segment({
    aud: new URL(input.endpoint).origin,
    exp,
    sub: input.subject,
  })}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { ...P256, hash: 'SHA-256' },
      input.keys.privateKey,
      text.encode(unsigned),
    ),
  );
  return `vapid t=${unsigned}.${encodeBase64Url(signature)}, k=${input.publicKey}`;
}
