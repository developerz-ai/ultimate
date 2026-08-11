// The one locale resolver for generated catalogs: the default set, validation, canonical form and
// dedupe. A locale is not a label here, it is a file stem — `packages/i18n/catalogs/<locale>.json`
// — so an unvalidated tag is a path, and `--locales=../../../../tmp` would write outside the app.

import { BadFlagError, ScaffoldPathEscapeError } from '../errors';

/** What a generated catalog ships for when the caller names no locale. */
export const DEFAULT_LOCALES: readonly string[] = ['en'];

/** Where every generated catalog lands. The locale is the file's stem, hence the containment. */
export const CATALOG_ROOT = 'packages/i18n/catalogs';

/** The catalog layout, written down once: `x g route` and `x g resource` both merge into it. */
export const catalogPath = (locale: string): string => `${CATALOG_ROOT}/${locale}.json`;

/** The runnable form of the flag, used as the fix on every rejection below. */
const LOCALES_FIX = 'x g resource <name> --locales=en,es';

/**
 * Anything that could steer a write out of `CATALOG_ROOT`. A path segment is safe exactly when it
 * holds no separator, no NUL and is not a dot segment, so this is a complete check at this level —
 * `writeFiles` proves containment again on the assembled path.
 */
const escapesCatalogRoot = (tag: string): boolean =>
  tag.startsWith('.') || tag.includes('/') || tag.includes('\\') || tag.includes('\0');

/**
 * The repo's own definition of a BCP-47 tag — the predicate `defineConfig` validates `locales`
 * with. `Intl` canonicalizes (`EN` → `en`, `zh-Hant` stays) and throws on anything that is not a
 * tag, which is why `x-priv`, `en_US` and `1234` never reach the filesystem.
 */
const canonicalTag = (tag: string): string | undefined => {
  try {
    const canonical = Intl.getCanonicalLocales(tag);
    return canonical.length === 1 ? canonical[0] : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The invocation a rejection is reported against. `x g --locales=…` is not the only caller —
 * `x i18n add <locale>` reaches this same validator — and a cause naming a command and a flag the
 * user never typed is the misdirection axiom 4 exists to refuse.
 */
export interface LocaleFlagContext {
  /** The runnable fix printed on a rejection. Defaults to the `x g` form. */
  readonly fix?: string;
  /** The command as typed, without the `x`. */
  readonly command?: string;
  /** The flag or argument the locale arrived on. */
  readonly flag?: string;
}

/**
 * Every locale a generated catalog ships for: trimmed, validated, lowercased and deduped, or the
 * default when the caller names none. Loud rather than lenient — a typo silently resolved to `en`
 * writes a catalog the app never reads, and a traversal silently dropped writes one it never sees.
 */
export function resolveLocales(
  requested?: readonly string[],
  // A bare string is still the fix, so every `x g` call site reads exactly as it did.
  context: string | LocaleFlagContext = LOCALES_FIX,
): readonly string[] {
  if (requested === undefined) return DEFAULT_LOCALES;
  const options: LocaleFlagContext = typeof context === 'string' ? { fix: context } : context;
  const fix = options.fix ?? LOCALES_FIX;
  const command = options.command ?? 'g';
  const flag = options.flag ?? 'locales';
  const resolved: string[] = [];
  for (const raw of requested) {
    const tag = raw.trim();
    // `--locales=en,,es` is a typing artefact, not a request for a nameless catalog.
    if (tag.length === 0) continue;
    if (escapesCatalogRoot(tag)) {
      throw new ScaffoldPathEscapeError({ path: `${CATALOG_ROOT}/${tag}`, dir: CATALOG_ROOT, fix });
    }
    const canonical = canonicalTag(tag);
    if (canonical === undefined) {
      throw new BadFlagError({
        flag,
        command,
        reason: `"${tag}" is not a BCP-47 locale`,
        fix,
      });
    }
    // Lowercase, because the tag is a file stem: `en-US.json` and `en-us.json` are one file on a
    // case-insensitive filesystem, and `zh-hant` is the normalized form @ultimat3/i18n resolves to.
    const stem = canonical.toLowerCase();
    if (!resolved.includes(stem)) resolved.push(stem);
  }
  return resolved.length === 0 ? DEFAULT_LOCALES : resolved;
}
