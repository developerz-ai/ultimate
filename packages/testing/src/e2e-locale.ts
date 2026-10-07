// The locale an e2e run's browser asks for: the default the app's `defineCatalogs()` declared —
// the one place an app names its locales since 25.0.0 (`app.config.ts`'s `defaultLocale` and
// `locales` keys were deleted). Read through `@ultimat3/i18n/app-catalogs`, the one reader the CLI
// shares; what is this file's own is the answer to a module that will not load.

/**
 * The app's default locale, or `undefined` when it cannot be read — and then nothing is pinned.
 * Never a guessed `en`: `loadAppCatalogs` answers only when a `defineCatalogs()` was declared.
 * Pinning the wrong language would make every run photograph and assert on a page no visitor at
 * the unprefixed URL sees. The import runs the app's module, which may validate an environment
 * this process lacks — so a module that throws is "nothing pinned", never a failed run.
 */
export async function e2eDefaultLocale(root: string): Promise<string | undefined> {
  // Dynamic, like every non-core dependency of this package: only the e2e preload pays for it.
  const { loadAppCatalogs } = await import('@ultimat3/i18n/app-catalogs');
  try {
    return (await loadAppCatalogs(root))?.defaultLocale;
  } catch {
    return undefined;
  }
}
