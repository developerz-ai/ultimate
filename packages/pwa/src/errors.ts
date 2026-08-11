/**
 * PWA error codes. Everything that breaks a PWA in production — a missing offline
 * fallback, a missing build id, a bad scope — fails here at build time instead.
 */

import { registerErrorCodes, UltimateError } from '@ultimat3/core';

/** Codes this package declares and owns. */
export const PWA_OWNED_ERROR_CODES = [
  'X_PWA_NO_OFFLINE_FALLBACK',
  'X_PWA_ICON_MISSING',
  'X_PWA_MANIFEST_INVALID',
  'X_BUILD_ID_MISSING',
  'X_SW_SCOPE_INVALID',
  'X_PWA_STRATEGY_EXHAUSTED',
  'X_PWA_SYNC_FLUSH_FAILED',
  'X_PWA_SYNC_INCOMPLETE',
] as const;

/**
 * `X_NOT_IMPLEMENTED` is `@ultimat3/core`'s. Thrown here, titled only there — the copy this file
 * used to keep was a second title that could drift from core's with nothing to catch it.
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
};

// One unconditional call, so a second package claiming one of pwa's codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(Object.entries(PWA_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

const docsFor = (code: PwaErrorCode): string => `https://ultimate.dev/errors/${code}`;

/** No `app/offline.tsx`. You cannot ship a PWA that has nothing to show offline. */
export class PwaNoOfflineFallbackError extends UltimateError {
  static readonly code = 'X_PWA_NO_OFFLINE_FALLBACK' as const;
  constructor(cause: string, fix: string) {
    super({
      code: PwaNoOfflineFallbackError.code,
      cause,
      fix,
      docs: docsFor(PwaNoOfflineFallbackError.code),
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
      docs: docsFor(PwaIconMissingError.code),
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
      docs: docsFor(PwaManifestInvalidError.code),
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
      docs: docsFor(BuildIdMissingError.code),
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
      docs: docsFor(SwScopeInvalidError.code),
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
      fix: 'pass StrategyOptions.fallback to staleWhileRevalidate, or set pwa.offline.fallback so requireOfflineFallback wires one in',
      docs: docsFor(PwaStrategyExhaustedError.code),
    });
  }
}

/**
 * Documents the two failures `backgroundSyncSource()` emits into `sw.js`. The generated code runs
 * in the browser's service-worker realm, which has no bundler and no `@ultimat3/core` to import —
 * so the emitted `throw new Error(...)` there carries the code as text (`X_PWA_SYNC_FLUSH_FAILED: …`)
 * instead of constructing this class. It exists so the code has one title, one fix and one wiki
 * row, the same as every other code in this file, even though nothing in this package throws it.
 */
export class PwaSyncFlushFailedError extends UltimateError {
  static readonly code = 'X_PWA_SYNC_FLUSH_FAILED' as const;
  constructor(cause: string, fix: string) {
    super({
      code: PwaSyncFlushFailedError.code,
      cause,
      fix,
      docs: docsFor(PwaSyncFlushFailedError.code),
    });
  }
}

/** Documented for the same reason as {@link PwaSyncFlushFailedError} — see its comment. */
export class PwaSyncIncompleteError extends UltimateError {
  static readonly code = 'X_PWA_SYNC_INCOMPLETE' as const;
  constructor(cause: string, fix: string) {
    super({
      code: PwaSyncIncompleteError.code,
      cause,
      fix,
      docs: docsFor(PwaSyncIncompleteError.code),
    });
  }
}

/** A driver whose interface exists and whose backing implementation does not, yet. */
export class NotImplementedError extends UltimateError {
  static readonly code = 'X_NOT_IMPLEMENTED' as const;
  constructor(cause: string, fix: string) {
    super({
      code: NotImplementedError.code,
      cause,
      fix,
      docs: docsFor(NotImplementedError.code),
    });
  }
}
