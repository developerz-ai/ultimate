// Single responsibility: prove a Resend webhook came from Resend. Resend signs with Svix: HMAC-SHA256
// over `<svix-id>.<svix-timestamp>.<body>` under the endpoint's `whsec_` secret, base64, sent as one
// or more `v1,<mac>` entries in `svix-signature` (more than one while a secret rotates). The mac is
// compared in constant time, and checked BEFORE the window, so "stale" always means authentic.

import { type Clock, ConfigInvalidError, systemClock, timingSafeEqual } from '@ultimat3/core';
import { deliveryEventUnverified } from './delivery-event-errors';

/** Svix's own default, and the replay bound every Svix sender already assumes. */
export const DEFAULT_SVIX_TOLERANCE_MS = 300_000;

/** Svix's `whsec_` prefix. Stripped by pattern: the prefix is public, the rest is the key. */
const SECRET_PREFIX = /^whsec_/;
/** Svix ids are `msg_<base62>`; a bound keeps a pathological header out of the mac input. */
const SVIX_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SVIX_TIMESTAMP = /^\d{1,12}$/;

export interface SvixHeaders {
  readonly id: string | null;
  readonly timestamp: string | null;
  readonly signature: string | null;
}

/** The key bytes of a `whsec_<base64>` secret — synchronous, so a bad one is refused at construction. */
export function svixSecretBytes(secret: string): Uint8Array<ArrayBuffer> {
  const encoded = secret.replace(SECRET_PREFIX, '');
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  } catch {
    bytes = undefined;
  }
  if (bytes === undefined || bytes.byteLength < 16) {
    throw new ConfigInvalidError({
      cause:
        'the Resend webhook secret is not a whsec_<base64> signing secret of at least 16 bytes',
      fix: "createResendEventReceiver({ secret: env.RESEND_WEBHOOK_SECRET }) — with the endpoint's whsec_ signing secret from https://resend.com/webhooks",
    });
  }
  return bytes;
}

export function svixKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

function base64(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Every `v1` mac in the header. Other versions are skipped, as Svix's own verifier does. */
function v1Signatures(header: string): readonly string[] {
  return header
    .split(' ')
    .filter((entry) => entry.startsWith('v1,'))
    .map((entry) => entry.slice(3));
}

export interface SvixVerifyOptions {
  readonly key: CryptoKey;
  readonly toleranceMs: number;
  readonly clock?: Clock | undefined;
}

/** Resolves when the delivery is authentic and fresh; rejects `X_MAIL_EVENT_UNVERIFIED` otherwise. */
export async function verifySvix(
  headers: SvixHeaders,
  body: string,
  options: SvixVerifyOptions,
): Promise<{ readonly eventId: string }> {
  const { id, timestamp, signature } = headers;
  if (id === null || timestamp === null || signature === null) {
    throw deliveryEventUnverified('resend', 'unsigned');
  }
  if (!SVIX_ID.test(id) || !SVIX_TIMESTAMP.test(timestamp)) {
    throw deliveryEventUnverified('resend', 'signature');
  }
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  const expected = base64(await crypto.subtle.sign('HMAC', options.key, signed));
  // Every entry is compared, with no early exit, so the position of the match leaks nothing.
  let matched = false;
  for (const candidate of v1Signatures(signature)) {
    if (timingSafeEqual(candidate, expected)) matched = true;
  }
  if (!matched) throw deliveryEventUnverified('resend', 'signature');
  const now = (options.clock ?? systemClock).now().getTime();
  if (Math.abs(now - Number(timestamp) * 1000) > options.toleranceMs) {
    throw deliveryEventUnverified('resend', 'stale');
  }
  return { eventId: id };
}
