/**
 * PWA error codes. Everything that breaks a PWA in production — a missing offline
 * fallback, a missing build id, a bad scope — fails here at build time instead.
 */

import { registerErrorCodes, registerErrorRetry, UltimateError } from '@ultimat3/core';

/** Codes this package declares and owns. */
export const PWA_OWNED_ERROR_CODES = [
  'X_PWA_NO_OFFLINE_FALLBACK',
  'X_PWA_ICON_MISSING',
  'X_PWA_MANIFEST_INVALID',
  'X_BUILD_ID_MISSING',
  'X_SW_SCOPE_INVALID',
  'X_PWA_STRATEGY_EXHAUSTED',
  // Shipped, so stable forever — and thrown by nothing since 21.0.0, when the worker stopped
  // POSTing to `/_x/outbox/flush` (`background-sync.ts`). Registered so an old log still explains.
  'X_PWA_SYNC_FLUSH_FAILED',
  'X_PWA_SYNC_INCOMPLETE',
  'X_PWA_VAPID_KEY_MISSING',
  'X_PWA_VAPID_KEY_INVALID',
  'X_PWA_PUSH_UNCONFIGURED',
  'X_PWA_PUSH_FAILED',
  'X_PWA_PUSH_REJECTED',
  'X_PWA_PUSH_PAYLOAD_TOO_LARGE',
  'X_PWA_PUSH_SUBSCRIPTION_INVALID',
  'X_PWA_PUSH_HOST_UNLISTED',
] as const;

/**
 * `X_NOT_IMPLEMENTED` is `@ultimat3/core`'s — constructed only there, by core's own
 * `NotImplementedError`, and titled only there: the copy this file used to keep was a second title
 * that could drift from core's with nothing to catch it.
 */
export const PWA_BORROWED_ERROR_CODES = ['X_NOT_IMPLEMENTED'] as const;

/** Every code pwa can throw: the ones it owns plus the one it borrows. */
export const PWA_ERROR_CODES = [...PWA_OWNED_ERROR_CODES, ...PWA_BORROWED_ERROR_CODES] as const;

export type PwaOwnedErrorCode = (typeof PWA_OWNED_ERROR_CODES)[number];
export type PwaErrorCode = (typeof PWA_ERROR_CODES)[number];

export const PWA_ERROR_TITLES: Readonly<Record<PwaOwnedErrorCode, string>> = {
  X_PWA_NO_OFFLINE_FALLBACK: 'pwa.offline.fallback is not set',
  X_PWA_ICON_MISSING: 'no source icon to generate from',
  X_PWA_MANIFEST_INVALID: 'the generated web manifest failed validation',
  X_BUILD_ID_MISSING: 'no immutable build ID',
  X_SW_SCOPE_INVALID: 'the service-worker scope cannot serve the routes it precaches',
  X_PWA_STRATEGY_EXHAUSTED: 'a caching strategy had no cache, no network and no fallback',
  X_PWA_SYNC_FLUSH_FAILED: 'the background-sync outbox flush was rejected',
  X_PWA_SYNC_INCOMPLETE: 'the background-sync outbox flush left mutations queued',
  X_PWA_VAPID_KEY_MISSING: 'no VAPID key pair for push',
  X_PWA_VAPID_KEY_INVALID: 'the VAPID key pair is malformed or not a pair',
  X_PWA_PUSH_UNCONFIGURED: 'push is not configured in this process',
  X_PWA_PUSH_FAILED: 'the push service did not accept the message, and may later',
  X_PWA_PUSH_REJECTED: 'the push service refused the message and will refuse it again',
  X_PWA_PUSH_PAYLOAD_TOO_LARGE: 'the push message does not fit one 4096-byte record',
  X_PWA_PUSH_SUBSCRIPTION_INVALID: 'the push subscription is not one a browser produced',
  X_PWA_PUSH_HOST_UNLISTED: 'the push endpoint is not on a push service this app sends to',
};

// One unconditional call, so a second package claiming one of pwa's codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(Object.entries(PWA_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

// No `docs:` on the subclasses below. `UltimateError` fills it from `describeErrorCode(code).docs`,
// which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for every code, never one per code, because
// `wiki/` is the framework's only public documentation surface and a code lives there in a TABLE ROW,
// which has no anchor. The `https://ultimate.dev/errors/<code>` links this file built until 9.x
// answered 404, host included, on every error it has ever thrown; restating the replacement here
// would be the same constant in eight places waiting to drift again.

/** No `app/offline.tsx`. You cannot ship a PWA that has nothing to show offline. */
export class PwaNoOfflineFallbackError extends UltimateError {
  static readonly code = 'X_PWA_NO_OFFLINE_FALLBACK' as const;
  constructor(cause: string, fix: string) {
    super({
      code: PwaNoOfflineFallbackError.code,
      cause,
      fix,
    });
  }
}

/** The single source icon is missing or too small to derive the size matrix from. */
export class PwaIconMissingError extends UltimateError {
  static readonly code = 'X_PWA_ICON_MISSING' as const;
  constructor(cause: string, fix: string) {
    super({
      code: PwaIconMissingError.code,
      cause,
      fix,
    });
  }
}

/** The generated web manifest would be rejected by the browser. */
export class PwaManifestInvalidError extends UltimateError {
  static readonly code = 'X_PWA_MANIFEST_INVALID' as const;
  constructor(cause: string, fix: string) {
    super({
      code: PwaManifestInvalidError.code,
      cause,
      fix,
    });
  }
}

/** No immutable build id, so caches cannot be keyed and skew cannot be detected. */
export class BuildIdMissingError extends UltimateError {
  static readonly code = 'X_BUILD_ID_MISSING' as const;
  constructor(cause: string, fix: string) {
    super({
      code: BuildIdMissingError.code,
      cause,
      fix,
    });
  }
}

/** The service worker's scope cannot cover the URLs it is asked to control. */
export class SwScopeInvalidError extends UltimateError {
  static readonly code = 'X_SW_SCOPE_INVALID' as const;
  constructor(cause: string, fix: string) {
    super({
      code: SwScopeInvalidError.code,
      cause,
      fix,
    });
  }
}

/**
 * A strategy exhausted the cache, the network, and any declared fallback. Runs in-process (the
 * `STRATEGY_FNS` half of `strategies.ts`, tested for parity with the `STRATEGY_SOURCE` emitted
 * into `sw.js`), so it can import core the way the generated bundle below cannot.
 */
export class PwaStrategyExhaustedError extends UltimateError {
  static readonly code = 'X_PWA_STRATEGY_EXHAUSTED' as const;
  constructor(input: { cacheName: string }) {
    super({
      code: PwaStrategyExhaustedError.code,
      cause: `no cached response and the network failed for "${input.cacheName}"`,
      fix: 'pass options.fallback to staleWhileRevalidate(request, env, options), or set pwa.offline.fallback in app.config.ts',
    });
  }
}

// Web Push. `X_PWA_PUSH_FAILED` is the one a retry can cure — the same message landing later —
// so it is `retry-after` (a 429's `Retry-After` is honoured through `meta.retryAfterSeconds`); the
// rest describe the key, the subscription or the body, and every attempt meets them unchanged.
registerErrorRetry({
  X_PWA_PUSH_FAILED: 'retry-after',
  X_PWA_PUSH_REJECTED: 'terminal',
  X_PWA_PUSH_PAYLOAD_TOO_LARGE: 'terminal',
  X_PWA_PUSH_SUBSCRIPTION_INVALID: 'terminal',
  X_PWA_PUSH_HOST_UNLISTED: 'terminal',
  X_PWA_VAPID_KEY_MISSING: 'terminal',
  X_PWA_VAPID_KEY_INVALID: 'terminal',
  X_PWA_PUSH_UNCONFIGURED: 'terminal',
});

/** The boot refuses push with no key pair in a deployed environment. */
export class PwaVapidKeyMissingError extends UltimateError {
  static readonly code = 'X_PWA_VAPID_KEY_MISSING' as const;
  constructor(input: { missing: readonly string[]; deployed: boolean }) {
    const unset = `${input.missing.join(' and ')} ${input.missing.length === 1 ? 'is' : 'are'} unset`;
    super({
      code: PwaVapidKeyMissingError.code,
      cause: input.deployed
        ? `pwa.push is true and ${unset} (or holds the published development key), and a deployed environment never signs with the development pair`
        : `pwa.push is true and ${unset} while its other half is set — half a pair is never completed with the development one`,
      fix: "x vapid create   # seals a fresh pair into secrets.enc.json; or set ULTIMATE_VAPID_PUBLIC_KEY and ULTIMATE_VAPID_PRIVATE_KEY in the deployment's environment",
      meta: { missing: [...input.missing] },
    });
  }
}

/** A key that is not a P-256 key, or a private key that does not sign for its public half. */
export class PwaVapidKeyInvalidError extends UltimateError {
  static readonly code = 'X_PWA_VAPID_KEY_INVALID' as const;
  constructor(input: { key: string; reason: string }) {
    super({
      code: PwaVapidKeyInvalidError.code,
      cause: `${input.key} ${input.reason}`,
      fix: 'x vapid create   # one command writes both halves, so they cannot disagree',
      meta: { key: input.key },
    });
  }
}

/** Push used in a process whose boot installed no Web Push runtime. */
export class PwaPushUnconfiguredError extends UltimateError {
  static readonly code = 'X_PWA_PUSH_UNCONFIGURED' as const;
  constructor(input: { operation: string }) {
    super({
      code: PwaPushUnconfiguredError.code,
      cause: `${input.operation} ran in a process whose boot installed no Web Push runtime: pwa.push is false, or pwa.enabled is`,
      fix: "pwa: { enabled: true, push: true, vapid: { subject: 'mailto:ops@example.com' } }   # in app.config.ts; a test calls installWebPush({ store, keys, subject }) first",
    });
  }
}

/** The push service may accept the same message later: a 429, a 5xx, or no connection at all. */
export class PwaPushFailedError extends UltimateError {
  static readonly code = 'X_PWA_PUSH_FAILED' as const;
  constructor(input: {
    origin: string;
    status: number | null;
    detail: string;
    retryAfterSeconds?: number | undefined;
  }) {
    super({
      code: PwaPushFailedError.code,
      cause: `the push service at ${input.origin} answered ${input.status === null ? input.detail : `status ${input.status}`}`,
      fix: 'x jobs list --json   # the job retries on its policy; a stated Retry-After rides in meta.retryAfterSeconds',
      meta: {
        origin: input.origin,
        status: input.status,
        ...(input.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: input.retryAfterSeconds }),
      },
    });
  }
}

/** The push service refused the message, and will refuse it again. */
export class PwaPushRejectedError extends UltimateError {
  static readonly code = 'X_PWA_PUSH_REJECTED' as const;
  constructor(input: { origin: string; status: number; body: string }) {
    super({
      code: PwaPushRejectedError.code,
      cause: `the push service at ${input.origin} refused the message with status ${input.status}${input.body === '' ? '' : `: ${input.body}`}`,
      fix:
        input.status === 403 || input.status === 401
          ? 'x vapid show   # the subscription was made with another public key: a key change means every subscriber subscribes again'
          : "vapid: { subject: 'mailto:ops@example.com' }   # pwa.vapid in app.config.ts — the push service's answer in the cause names the field it refused",
      meta: { origin: input.origin, status: input.status },
    });
  }
}

/** One record is 4096 bytes; RFC 8291 leaves 3993 of them for the notification. */
export class PwaPushPayloadTooLargeError extends UltimateError {
  static readonly code = 'X_PWA_PUSH_PAYLOAD_TOO_LARGE' as const;
  constructor(input: { bytes: number; limit: number }) {
    super({
      code: PwaPushPayloadTooLargeError.code,
      cause: `the rendered notification is ${input.bytes} bytes and one Web Push record carries ${input.limit}`,
      fix: "url: '/posts/1'   # send a path to the content and shorten the catalog strings — never the content itself",
      meta: { bytes: input.bytes, limit: input.limit },
    });
  }
}

/** A subscription no browser produced: a non-https endpoint, or keys of the wrong size. */
export class PwaPushSubscriptionInvalidError extends UltimateError {
  static readonly code = 'X_PWA_PUSH_SUBSCRIPTION_INVALID' as const;
  constructor(input: { field: string; reason: string }) {
    super({
      code: PwaPushSubscriptionInvalidError.code,
      cause: `${input.field} ${input.reason}`,
      fix: "import { subscribeToPush } from '@ultimat3/pwa/client';   // it sends PushSubscription.toJSON() unchanged",
      meta: { field: input.field },
    });
  }
}

/**
 * An endpoint whose host is not a push service this app sends to. The endpoint arrives in a request
 * body, and a hostname can resolve anywhere — a private address, the metadata service — so the one
 * screen that holds is a list of the services themselves (`push-hosts.ts`), not a check of where a
 * name points today.
 */
export class PwaPushHostUnlistedError extends UltimateError {
  static readonly code = 'X_PWA_PUSH_HOST_UNLISTED' as const;
  constructor(input: { host: string }) {
    super({
      code: PwaPushHostUnlistedError.code,
      cause: `the endpoint's host ${input.host} is neither a built-in push service (PUSH_SERVICE_HOSTS: FCM, Mozilla, Apple, WNS, or a subdomain of one) nor listed in pwa.vapid.pushHosts`,
      fix: "vapid: { subject: 'mailto:ops@example.com', pushHosts: ['push.example.com'] }   # pwa.vapid.pushHosts in app.config.ts, for a push service the built-in list does not name",
      meta: { host: input.host },
    });
  }
}
