// Single responsibility: ONE push message to ONE subscription — encrypt (RFC 8291), sign
// (RFC 8292), POST (RFC 8030), and read the answer into one of three outcomes: delivered, gone, or
// a coded refusal saying whether a retry can help.

import type { Clock } from '@ultimat3/core';
import { isRetryableStatus, renderThrowable, retryAfterSecondsOf } from '@ultimat3/core';
import {
  PwaPushFailedError,
  PwaPushRejectedError,
  PwaPushSubscriptionInvalidError,
} from './errors';
import { encodeBase64Url } from './push-bytes';
import type { PushEncryptionKeys } from './push-encrypt';
import { encryptPushMessage } from './push-encrypt';
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
}

export type PushSendOutcome =
  | { readonly kind: 'delivered'; readonly status: number }
  /** 404/410: the subscription is dead. Delete it; never retry it. */
  | { readonly kind: 'gone'; readonly status: 404 | 410 };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `https:` — every push service is — or `http:` to a loopback host, which is a test's stub push
 * service and nothing a browser ever hands out. Anything else is refused before a byte is sent:
 * the endpoint came from a request body, and an `http:` endpoint on another host is a request this
 * server would make, in the clear, to wherever a caller pointed it.
 */
export function pushEndpointProblem(endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'is not an absolute URL';
  }
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return undefined;
  return 'is not an https URL';
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

/** Delivered, gone, or a coded throw: `X_PWA_PUSH_FAILED` (retry) / `X_PWA_PUSH_REJECTED` (don't). */
export async function sendPushMessage(input: PushSendInput): Promise<PushSendOutcome> {
  const problem = pushEndpointProblem(input.target.endpoint);
  if (problem !== undefined) {
    throw new PwaPushSubscriptionInvalidError({ field: 'endpoint', reason: problem });
  }
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
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
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
