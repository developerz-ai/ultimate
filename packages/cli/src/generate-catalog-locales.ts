// The catalogs a generator emits, made true for every locale they target. A template speaks the
// default locale only, so its strings are copied MARKED into every other locale — the seed
// `x i18n add` and `x i18n sync` write — and a locale the app has no catalog for yet is refused
// with `x i18n add <locale>`, the one command that starts a catalog holding every existing key.

import { renderFixShellArg } from '@ultimat3/core';
import { type Catalog, loadCatalog } from '@ultimat3/i18n';
import { loadAppConfig } from './app-config-load';
import { BadFlagError } from './errors';
import { resolveDefaultLocale, seedCatalog, serializeCatalog } from './i18n-audit';
import { catalogLocales } from './i18n-index';
import type { GeneratedFile } from './templates';
import { CATALOG_ROOT, catalogPath } from './templates';

/** The locale a `merge: 'json'` file is the catalog of, or `undefined` for any other file. */
const localeOf = (file: GeneratedFile): string | undefined => {
  if (file.merge !== 'json') return undefined;
  const prefix = `${CATALOG_ROOT}/`;
  if (!file.path.startsWith(prefix) || !file.path.endsWith('.json')) return undefined;
  const stem = file.path.slice(prefix.length, -'.json'.length);
  return stem.includes('/') ? undefined : stem;
};

/**
 * `app.config.ts`'s `defaultLocale`, or `undefined` when there is no config or it will not load —
 * `x g` is not the command that refuses an app over its config: the manifest load after the write
 * reports that, with its own fix.
 */
async function declaredDefault(root: string): Promise<string | undefined> {
  try {
    return (await loadAppConfig(root))?.defaultLocale;
  } catch {
    return undefined;
  }
}

const asLocaleSet = (locales: readonly string[]): Readonly<Record<string, Catalog>> =>
  Object.fromEntries(locales.map((locale) => [locale, {}]));

/**
 * `files` with every non-default catalog's values marked. The default is resolved by
 * `x i18n add`'s own rule (`resolveDefaultLocale`) over the catalogs on disk, and — in an app with
 * none yet — over the catalogs this run starts, so a first `--locales en,es` writes `en` bare and
 * `es` marked, both holding the same keys.
 *
 * Refuses, before anything is planned to disk, a non-default locale with no catalog in an app that
 * HAS catalogs: a file started here would hold this generator's keys and none of the app's, which
 * the scaffold's "every locale has the same keys" test and `x i18n check` both answer red.
 */
export async function localiseCatalogs(
  root: string,
  files: readonly GeneratedFile[],
): Promise<readonly GeneratedFile[]> {
  const targeted = [...new Set(files.flatMap((file) => localeOf(file) ?? []))];
  if (targeted.length === 0) return files;
  const onDisk = await catalogLocales(root);
  const declared = await declaredDefault(root);
  const fallback =
    resolveDefaultLocale(declared, asLocaleSet(onDisk)) ??
    resolveDefaultLocale(declared, asLocaleSet(targeted));
  if (onDisk.length > 0) {
    const absent = targeted.find((locale) => locale !== fallback && !onDisk.includes(locale));
    if (absent !== undefined) {
      throw new BadFlagError({
        flag: 'locales',
        command: 'g',
        reason: `no catalog for "${absent}" at ${catalogPath(absent)}, and one started by a generator would hold only its own keys`,
        fix: `x i18n add ${renderFixShellArg(absent, '<locale>')}`,
      });
    }
  }
  return files.map((file) => {
    const locale = localeOf(file);
    if (file.merge !== 'json' || locale === undefined || locale === fallback) return file;
    if (fallback === undefined) return file;
    const generated: unknown = JSON.parse(file.contents);
    return { ...file, contents: serializeCatalog(seedCatalog(loadCatalog(generated))) };
  });
}
