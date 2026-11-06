// `verifyBodyHmac`: the one vendor-neutral check many inbound webhooks share — HMAC-SHA256 under a
// UTF-8 secret over bytes the caller names, compared in constant time, under any secret of a
// rotation list. It does not decode a secret (Svix's base64 `whsec_` key is the mail receivers'),
// and the bytes and the header are the vendor's: no vendor verifier ships (axiom 8).

import { hmac, timingSafeEqual } from '@ultimat3/core';
import { webhookSignatureInvalid } from './errors';
import { assertWebhookSecrets } from './webhook-verify';

export interface BodyHmacOptions {
  /** The bytes the vendor signed. A string is its UTF-8 encoding. */
  readonly bytes: Uint8Array | string;
  /** The shared secret, or the list a rotation keeps live — any one of them verifies. */
  readonly secret: string | readonly string[];
  /** The mac the request carried, header value as sent. Absent or empty is a refusal. */
  readonly given: string | null | undefined;
  readonly encoding: 'hex' | 'base64';
  /** What precedes the mac in `given`: `sha256=` (GitHub), `v0=` (Slack). Compared, not stripped. */
  readonly prefix?: string;
}

/**
 * What a passing check answers: the bytes it verified, and their text when they are UTF-8. Read
 * the event id from HERE, never from an unsigned header — an id outside the mac lets one captured
 * signature replay under any id the attacker picks.
 */
export interface VerifiedBody {
  readonly bytes: Uint8Array;
  readonly text: string | null;
}

/** `fatal`: invalid UTF-8 is `null` text, never replacement characters an id could be read from. */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Prove `given` is `prefix + HMAC-SHA256(secret, bytes)` for one of the secrets, and answer what
 * was verified. Throws `X_WEBHOOK_SIGNATURE_INVALID` (401) on a mismatch and `X_CONFIG_INVALID`
 * for no usable secret.
 */
export function verifyBodyHmac(options: BodyHmacOptions): VerifiedBody {
  const secrets = assertWebhookSecrets(options.secret, 'verifyBodyHmac');
  const given = options.given ?? '';
  if (given === '') {
    throw webhookSignatureInvalid(
      'verifyBodyHmac',
      'the request carried no signature',
      'verifyBodyHmac',
    );
  }
  const prefix = options.prefix ?? '';
  let matched = false;
  // Every secret is tried, even after a match: which one matched is not worth a timing signal.
  for (const secret of secrets) {
    const expected = `${prefix}${hmac('sha256', secret, options.bytes, options.encoding)}`;
    if (timingSafeEqual(expected, given)) matched = true;
  }
  if (!matched) {
    throw webhookSignatureInvalid(
      'verifyBodyHmac',
      `no ${options.encoding} sha256 mac${prefix === '' ? '' : ` behind the "${prefix}" prefix`} under the ${secrets.length} configured secret(s) matches the bytes`,
      'verifyBodyHmac',
    );
  }
  const bytes =
    typeof options.bytes === 'string' ? new TextEncoder().encode(options.bytes) : options.bytes;
  let text: string | null;
  try {
    text = typeof options.bytes === 'string' ? options.bytes : strictUtf8.decode(bytes);
  } catch {
    text = null;
  }
  return { bytes, text };
}
