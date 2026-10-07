// The ONE reader of an app's declared locales: `defineCatalogs({ default, locales })` in the
// app's catalog module, imported and read back from this package's own `localeConfig()`. The CLI
// (pwa manifest, `x shot`, `x g`) and the e2e preload each kept a copy, and the copies disagreed.
// Server-only, so its own entry (`@ultimat3/i18n/app-catalogs`): `index.ts` is in every island.

// why: Bun exposes no path-join primitive; the catalog module is joined to the app root.
import { join } from 'node:path';
import { localeConfig, routedLocales } from './context';
import { catalogDeclarationCount, isDeclaredCatalogSet } from './define-catalogs';

/** Where an app declares its catalogs — `x new` writes it, and its `defineCatalogs()` runs there. */
export const APP_CATALOGS_PATH = 'packages/i18n/src/index.ts';

export interface AppLocaleSet {
  /** Every locale the app routes, its default first. */
  readonly locales: readonly string[];
  readonly defaultLocale: string;
}

/**
 * `root`'s declared locales, or `undefined` when no declaration ran: no catalog module, or one
 * that calls no `defineCatalogs()`. Never `localeConfig()` read blind — it ALWAYS answers a
 * fallback, so a module declaring nothing would inherit whatever an earlier import declared, and a
 * caller would pin a language no visitor sees. Declared means this import ran the call, or the
 * module exports the set one returned (a cached module evaluates once: the boot scan imported it).
 *
 * A module that will not import throws its own error: each caller decides whether that is a
 * refusal or "nothing declared".
 */
export async function loadAppCatalogs(root: string): Promise<AppLocaleSet | undefined> {
  const path = join(root, APP_CATALOGS_PATH);
  if (!(await Bun.file(path).exists())) return undefined;
  const before = catalogDeclarationCount();
  const module = (await import(path)) as Readonly<Record<string, unknown>>;
  const ran = catalogDeclarationCount() !== before;
  if (!ran && !Object.values(module).some(isDeclaredCatalogSet)) return undefined;
  const defaultLocale = localeConfig().fallback;
  if (defaultLocale === '') return undefined;
  return { locales: [...routedLocales()], defaultLocale };
}
