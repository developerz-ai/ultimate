/**
 * The X_* error codes owned by @ultimat3/i18n.
 * Every throw carries a stable code, a cause, and a command that fixes it.
 */

import { hasErrorCode, registerErrorCodes, UltimateError } from '@ultimat3/core';

export const I18N_ERROR_CODES = [
  'X_LOCALE_UNSUPPORTED',
  'X_CATALOG_MISSING_KEYS',
  'X_CATALOG_INVALID',
] as const;

export type I18nErrorCode = (typeof I18N_ERROR_CODES)[number];

export const I18N_ERROR_TITLES: Readonly<Record<I18nErrorCode, string>> = {
  X_LOCALE_UNSUPPORTED: 'locale is not in the supported set',
  X_CATALOG_MISSING_KEYS: 'a catalog is missing keys used in source',
  X_CATALOG_INVALID: 'a catalog entry is malformed',
};

// Titles must be registered for format() to render the contract's first line. Guarded
// because registering a code twice throws X_ERROR_CODE_DUPLICATE at import time.
for (const [code, title] of Object.entries(I18N_ERROR_TITLES)) {
  if (!hasErrorCode(code)) registerErrorCodes({ [code]: { title } });
}

export class I18nError extends UltimateError {
  constructor(init: { code: I18nErrorCode; cause: string; fix: string }) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      docs: `https://ultimate.dev/errors/${init.code}`,
    });
  }
}

export function localeUnsupported(tag: string, supported: readonly string[]): I18nError {
  return new I18nError({
    code: 'X_LOCALE_UNSUPPORTED',
    cause: `locale "${tag}" is not in the supported set [${supported.join(', ')}]`,
    fix: `x i18n add ${normalizeForFix(tag)}`,
  });
}

/**
 * `fix` must name the locale file and the exact keys — an agent reading this
 * error should not have to diff two catalogs to learn what to write.
 */
export function catalogMissingKeys(locale: string, keys: readonly string[]): I18nError {
  const shown = keys.slice(0, 12);
  const suffix = keys.length > shown.length ? `, +${keys.length - shown.length} more` : '';
  return new I18nError({
    code: 'X_CATALOG_MISSING_KEYS',
    cause: `packages/i18n/catalogs/${locale}.json is missing ${keys.length} key(s) used in source: ${shown.join(', ')}${suffix}`,
    fix: `x i18n sync ${locale}`,
  });
}

export function catalogInvalid(path: string, cause: string): I18nError {
  return new I18nError({
    code: 'X_CATALOG_INVALID',
    cause: `catalog entry "${path}": ${cause}`,
    fix: 'x i18n check --json',
  });
}

function normalizeForFix(tag: string): string {
  const primary = tag.split('-')[0] ?? tag;
  return primary.toLowerCase().replace(/[^a-z]/g, '') || 'xx';
}
