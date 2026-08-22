/**
 * The X_* error codes owned by @ultimat3/i18n.
 * Every throw carries a stable code, a cause, and a command that fixes it.
 */

import { registerErrorCodes, UltimateError } from '@ultimat3/core';

export const I18N_ERROR_CODES = [
  'X_LOCALE_UNSUPPORTED',
  'X_CATALOG_MISSING_KEYS',
  'X_CATALOG_INVALID',
  'X_CATALOG_UNREGISTERED',
] as const;

export type I18nErrorCode = (typeof I18N_ERROR_CODES)[number];

export const I18N_ERROR_TITLES: Readonly<Record<I18nErrorCode, string>> = {
  X_LOCALE_UNSUPPORTED: 'locale is not in the supported set',
  X_CATALOG_MISSING_KEYS: 'a catalog is missing keys used in source',
  X_CATALOG_INVALID: 'a catalog entry is malformed',
  X_CATALOG_UNREGISTERED: 'a shipped catalog never reached the runtime registry',
};

// Titles must be registered for format() to render the contract's first line. Every code above is
// owned here and none is borrowed, so the call is unconditional: a second package claiming one has
// to fail as X_ERROR_CODE_DUPLICATE, not quietly keep whichever title was registered first.
registerErrorCodes(
  Object.fromEntries(Object.entries(I18N_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

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
    fix: `x i18n sync ${locale}   # writes each key above as ⟦key⟧ — replace every one with the real string`,
  });
}

/**
 * The keys, capped and comma-joined. Shared by both factories below because a `fix:` an agent can
 * act on has to name keys, and a 300-key catalog rendered whole is a cause nobody reads.
 */
function shownKeys(keys: readonly string[]): string {
  const shown = keys.slice(0, 8);
  const suffix = keys.length > shown.length ? `, +${keys.length - shown.length} more` : '';
  return `${shown.join(', ')}${suffix}`;
}

/**
 * The fix is an EDIT, not a command, because no command can wire an import: registration is a side
 * effect of importing the module that calls `defineCatalogs()`, and the boot loads app modules by
 * scanning `packages/<pkg>/src` and `apps/<app>/{site,app,api,shared}` — a catalog module outside
 * that tree is never imported, and `x verify` stays green while every string renders a loud miss.
 */
const REGISTRATION_FIX =
  'move the defineCatalogs() call into packages/i18n/src/index.ts (where `x new` puts it, inside the boot scan) and read strings through its useT(), never `t` from @ultimat3/i18n; then re-run: x i18n check --json';

/**
 * A catalog the app ships that the running app cannot answer from. Issue #249: the file was on
 * disk, its keys were used in source, `x i18n check` and `x verify` were both green, and every
 * page rendered `⟦key⟧` because nothing had imported the module that registers it.
 */
export function catalogUnregistered(input: {
  locale: string;
  shipped: number;
  missing: readonly string[];
}): I18nError {
  return new I18nError({
    code: 'X_CATALOG_UNREGISTERED',
    cause: `packages/i18n/catalogs/${input.locale}.json defines ${input.shipped} key(s) and ${input.missing.length} of them are not in the runtime registry after the app's own modules loaded: ${shownKeys(input.missing)} — each renders \u27e6key\u27e7`,
    fix: REGISTRATION_FIX,
  });
}

/**
 * The same failure with nothing on disk to name: source calls `t()` and no catalog anywhere
 * answers. Distinct cause, same code and same fix — an audit that compared a missing file against
 * a missing catalog reported "no gaps", which is the vacuous green this code exists to refuse.
 */
export function catalogsNeverRegistered(locale: string, unresolved: readonly string[]): I18nError {
  return new I18nError({
    code: 'X_CATALOG_UNREGISTERED',
    cause: `no catalog is registered for "${locale}" and ${unresolved.length} key(s) used in source resolve to nothing: ${shownKeys(unresolved)} — each renders \u27e6key\u27e7`,
    fix: `x i18n add ${locale}   # then ${REGISTRATION_FIX}`.trim(),
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
