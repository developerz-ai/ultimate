// Single responsibility: ONE push message to ONE subscription — encrypt (RFC 8291), sign
// (RFC 8292), POST (RFC 8030), and read the answer into one of three outcomes: delivered, gone, or
// a coded refusal saying whether a retry can help.

import type { Clock } from '@ultimat3/core';
import {
  classifyAddress,
  isRetryableStatus,
  renderThrowable,
  retryAfterSecondsOf,
} from '@ultimat3/core';
import {
  PwaPushFailedError,
  PwaPushHostUnlistedError,
  PwaPushRejectedError,
  PwaPushSubscriptionInvalidError,
} from './errors';
import { encodeBase64Url } from './push-bytes';
import type { PushEncryptionKeys } from './push-encrypt';
import { encryptPushMessage } from './push-encrypt';
import { pushHostAllowed } from './push-hosts';
import { vapidAuthorization } from './vapid';

/** RFC 8030 §5.3. `high` wakes a sleeping phone; reserve it for what a person is waiting on. */
export const PUSH_URGENCIES = ['very-low', 'low', 'normal', 'high'] as const;
export type PushUrgency = (typeof PUSH_URGENCIES)[number];

/** A day. The push service drops an undelivered message after this — a stale alert is noise. */
export const DEFAULT_PUSH_TTL_SECONDS = 86_400;

/** How one message travels, as opposed to what it says. */
export interface PushDelivery {
  /** Seconds the push service holds the message for an offline device. 0 = now or never. */
  readonly ttlSeconds?: number | undefined;
  readonly urgency?: PushUrgency | undefined;
  /**
   * Collapse key AT THE PUSH SERVICE: a newer message with the same topic replaces one still
   * queued for an offline device. Any string — it is sent as the first 32 characters of its
   * SHA-256 in base64url, because the header admits exactly 32 URL-safe characters.
   */
  readonly topic?: string | undefined;
}

/** The signing half, resolved once per process: `push-runtime.ts` holds it. */
export interface VapidSigner {
  readonly keys: CryptoKeyPair;
  readonly publicKey: string;
  readonly subject: string;
}

export interface PushTarget {
  readonly endpoint: string;
  readonly keys: PushEncryptionKeys;
}

export interface PushSendInput {
  readonly target: PushTarget;
  /** The notification, serialized — `serializePushMessage`'s output, UTF-8 encoded. */
  readonly plaintext: Uint8Array;
  readonly vapid: VapidSigner;
  readonly delivery?: PushDelivery | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly clock?: Clock | undefined;
  readonly signal?: AbortSignal | undefined;
  /** `pwa.vapid.pushHosts`: push services beyond the built-in list (`push-hosts.ts`). */
  readonly pushHosts?: readonly string[] | undefined;
}

export type PushSendOutcome =
  | { readonly kind: 'delivered'; readonly status: number }
  /** 404/410: the subscription is dead. Delete it; never retry it. */
  | { readonly kind: 'gone'; readonly status: 404 | 410 };

/** How long one push service may take to answer before the fan-out moves on (retryable). */
export const PUSH_SEND_TIMEOUT_MS = 30_000;

/**
 * `https:` to a host on the public internet — every push service a browser hands out is one. The
 * endpoint came from a REQUEST BODY, so it is where a signed-in caller points this server: `http:`
 * would send in the clear, and `localhost` or an IP literal that is not public (loopback, private,
 * link-local, the metadata address) would make the server POST to its own side of the network.
 * No carve-out for tests: a stub push service is an injected `fetch` over an `https:` URL.
 */
export function pushEndpointProblem(endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'is not an absolute URL';
  }
  if (url.protocol !== 'https:') return 'is not an https URL';
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return 'names this machine';
  const kind = classifyAddress(host);
  if (kind !== undefined && kind !== 'public') return `is a ${kind} address`;
  return undefined;
}

async function topicHeader(topic: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(topic)),
  );
  return encodeBase64Url(digest).slice(0, 32);
}

const ttlOf = (delivery: PushDelivery | undefined): number => {
  const ttl = delivery?.ttlSeconds ?? DEFAULT_PUSH_TTL_SECONDS;
  return Number.isFinite(ttl) && ttl >= 0 ? Math.floor(ttl) : DEFAULT_PUSH_TTL_SECONDS;
};

/**
 * The screen an endpoint passes before it is stored and before every send: a well-formed public
 * `https:` URL (`X_PWA_PUSH_SUBSCRIPTION_INVALID`) on a push service this app sends to
 * (`X_PWA_PUSH_HOST_UNLISTED`). The list, not the name's shape, is what stops a hostname that
 * resolves to a private address: shape alone is checked before DNS, and DNS answers the attacker.
 */
export function assertPushEndpoint(endpoint: string, pushHosts: readonly string[] = []): void {
  const problem = pushEndpointProblem(endpoint);
  if (problem !== undefined) {
    throw new PwaPushSubscriptionInvalidError({ field: 'endpoint', reason: problem });
  }
  const host = new URL(endpoint).hostname;
  if (!pushHostAllowed(host, pushHosts)) throw new PwaPushHostUnlistedError({ host });
}

/** Delivered, gone, or a coded throw: `X_PWA_PUSH_FAILED` (retry) / `X_PWA_PUSH_REJECTED` (don't). */
export async function sendPushMessage(input: PushSendInput): Promise<PushSendOutcome> {
  assertPushEndpoint(input.target.endpoint, input.pushHosts);
  const origin = new URL(input.target.endpoint).origin;
  const body = await encryptPushMessage(input.target.keys, input.plaintext);
  const headers: Record<string, string> = {
    authorization: await vapidAuthorization({
      endpoint: input.target.endpoint,
      subject: input.vapid.subject,
      keys: input.vapid.keys,
      publicKey: input.vapid.publicKey,
      clock: input.clock,
    }),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(ttlOf(input.delivery)),
    urgency: input.delivery?.urgency ?? 'normal',
  };
  if (input.delivery?.topic !== undefined && input.delivery.topic !== '') {
    headers['topic'] = await topicHeader(input.delivery.topic);
  }
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(input.target.endpoint, {
      method: 'POST',
      headers,
      body,
      // Never followed: a redirect would carry a token signed for one origin to another.
      redirect: 'manual',
      // A deadline: one service that accepts and never answers must not hold the rest of the
      // fan-out — every later device of this person waits behind it.
      signal:
        input.signal === undefined
          ? AbortSignal.timeout(PUSH_SEND_TIMEOUT_MS)
          : AbortSignal.any([input.signal, AbortSignal.timeout(PUSH_SEND_TIMEOUT_MS)]),
    });
  } catch (error) {
    // The CALLER cancelled: not the push service's fault, so not the retryable class — a retry
    // would re-deliver to every device already served. Rethrown as is; the fan-out stops.
    if (input.signal?.aborted === true) throw error;
    throw new PwaPushFailedError({ origin, status: null, detail: renderThrowable(error) });
  }
  if (response.status >= 200 && response.status < 300) {
    await response.body?.cancel();
    return { kind: 'delivered', status: response.status };
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return { kind: 'gone', status: response.status };
  }
  if (isRetryableStatus(response.status)) {
    await response.body?.cancel();
    throw new PwaPushFailedError({
      origin,
      status: response.status,
      detail: `status ${response.status}`,
      retryAfterSeconds: retryAfterSecondsOf(
        response.headers.get('retry-after'),
        response.headers.get('date'),
      ),
    });
  }
  // The service's own words, bounded: FCM and Mozilla both name the field they refused.
  const text = (await response.text().catch(() => '')).slice(0, 200);
  throw new PwaPushRejectedError({ origin, status: response.status, body: text });
}
