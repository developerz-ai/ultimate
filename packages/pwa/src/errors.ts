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
