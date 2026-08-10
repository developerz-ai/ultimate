/**
 * PWA error codes. Everything that breaks a PWA in production — a missing offline
 * fallback, a missing build id, a bad scope — fails here at build time instead.
 */

import { hasErrorCode, registerErrorCodes, UltimateError } from '@ultimat3/core';

export const PWA_ERROR_CODES = [
  'X_PWA_NO_OFFLINE_FALLBACK',
  'X_PWA_ICON_MISSING',
  'X_PWA_MANIFEST_INVALID',
  'X_BUILD_ID_MISSING',
  'X_SW_SCOPE_INVALID',
  'X_NOT_IMPLEMENTED',
] as const;

export type PwaErrorCode = (typeof PWA_ERROR_CODES)[number];

export const PWA_ERROR_TITLES: Readonly<Record<PwaErrorCode, string>> = {
  X_PWA_NO_OFFLINE_FALLBACK: 'pwa.offline.fallback is not set',
  X_PWA_ICON_MISSING: 'no source icon to generate from',
  X_PWA_MANIFEST_INVALID: 'the generated web manifest failed validation',
  X_BUILD_ID_MISSING: 'no immutable build ID',
  X_SW_SCOPE_INVALID: 'the service-worker scope cannot serve the routes it precaches',
  X_NOT_IMPLEMENTED: 'this driver does not implement the requested feature',
};

// Titles must be registered for `format()` to render the contract's first line.
// `X_NOT_IMPLEMENTED` belongs to core — guarded so import order never throws
// X_ERROR_CODE_DUPLICATE.
for (const [code, title] of Object.entries(PWA_ERROR_TITLES)) {
  if (!hasErrorCode(code)) registerErrorCodes({ [code]: { title } });
}

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
