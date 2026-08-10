// The generated app's `packages/i18n`: one flat catalog file per locale, and the framework's one
// blessed typed-catalog shape (modelled on examples/dummy/packages/i18n/src/index.ts) — split out
// of scaffold-repo.ts to stay under the file-size ceiling.

import type { GeneratedFile, NameSet } from './naming';
import { camel } from './naming';
import { packageShapeFiles } from './scaffold-package-shape';

/** The only `packages/*` manifest that names a dependency: every other one only re-exports a
 * framework package's types, but this one statically imports `@ultimat3/i18n` at runtime. */
const i18nPackage = (app: NameSet, version: string): string => `{
  "name": "@${app.kebab}/i18n",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Flat catalogs with loud misses",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p ../../tsconfig.json"
  },
  "dependencies": {
    "@ultimat3/i18n": "^${version}"
  }
}
`;

/**
 * `en` first, then every other locale alphabetically — a stable order so a diff shows only the
 * locale a run actually added, never a reshuffle. `en` is always included: `default: 'en'` below
 * requires it to be a registered locale, and every real catalog set already has one from `x new`
 * scaffold time.
 */
const orderedLocales = (locales: readonly string[]): readonly string[] => {
  const rest = new Set(locales);
  rest.delete('en');
  return ['en', ...[...rest].sort()];
};

/** A locale tag is not always a valid JS binding (`zh-hant`) — `camel()` is the one identifier
 * derivation every generated file already uses for names, so the import agrees with the rest of
 * the app's own naming instead of inventing a second casing rule. */
const localeImport = (locale: string): string =>
  `import ${camel(locale)} from '../catalogs/${locale}.json';`;

/** The object-literal entry for one locale: shorthand when the binding IS the tag (`en`, `es`, …),
 * `'tag': binding` when `camel()` had to reshape it (`zh-hant` → `zhHant`) — `defineCatalogs` reads
 * the locale from the key, never the identifier, so the quoted form is what keeps it addressable. */
const localeEntry = (locale: string): string => {
  const binding = camel(locale);
  return binding === locale ? binding : `'${locale}': ${binding}`;
};

/**
 * The app's one catalog-registration module — regenerated, never hand-edited, to the full current
 * locale set every time `x g ... --locales` lands a new catalog file (`syncI18nIndex` in
 * `cmd-generate.ts`). `i18nFiles` below calls this with `['en']` for the shape `x new` has always
 * scaffolded; a later run passes whatever `packages/i18n/catalogs/` actually holds.
 */
export function i18nIndex(locales: readonly string[]): string {
  const ordered = orderedLocales(locales);
  const imports = ordered.map(localeImport).join('\n');
  const entries = ordered.map(localeEntry).join(', ');
  return `// The app's catalog, registered once and typed against English. Every surface resolves strings
// through this module, and an unknown key is a compile error via useT() — never a runtime miss
// nobody notices until production.

import {
  defineCatalogs,
  type TranslationKey as KeyOf,
  type Translator,
  useI18n,
} from '@ultimat3/i18n';
${imports}

export const catalogs = defineCatalogs({ default: 'en', locales: { ${entries} } });

/**
 * English is the source of truth for the key space — a second locale must match it exactly, or
 * \`x verify\` fails.
 */
export type AppCatalog = typeof en;

/** Every key this app's catalog defines — dot-paths, plus the stem of each plural family. */
export type TranslationKey = KeyOf<AppCatalog>;

/**
 * Use this, never \`useI18n()\` directly — the type parameter is what makes an unknown key a
 * compile error instead of a \`⟦key⟧\` someone notices in production.
 */
export const useT = (): Translator<AppCatalog> => useI18n<AppCatalog>();
`;
}

// `app.post.*` is not listed here: under `--example`, `x g resource post` merges its own keys
// into this same flat file (`merge: 'json'`, resolved by `dedupe()`); under `--no-example` that
// generator never runs, so those keys are simply absent, never a dangling reference.
const i18nCatalog = (app: NameSet): string => `{
  "site.home.title": "${app.pascal}",
  "site.home.description": "Everything you need, one command from shippable.",
  "site.home.cta": "Open the dashboard",
  "app.dashboard.title": "Dashboard",
  "app.dashboard.description": "Your workspace.",
  "app.offline.title": "You are offline",
  "app.offline.description": "This page will refresh itself when the connection returns.",
  "admin.home.title": "Admin",
  "admin.home.description": "Operations for ${app.pascal}."
}
`;

const i18nTest = (): string => `import { expect } from 'bun:test';
import { unitTest } from '@ultimat3/testing';
import { catalogs } from './index';

unitTest('every locale has the same keys as the default one', () => {
  const base = Object.keys(catalogs.catalogs[catalogs.default]).sort();
  for (const locale of catalogs.locales) {
    expect(Object.keys(catalogs.catalogs[locale]).sort()).toEqual(base);
  }
});

unitTest('no catalog value is empty', () => {
  for (const catalog of Object.values(catalogs.catalogs)) {
    for (const value of Object.values(catalog)) expect(value.length).toBeGreaterThan(0);
  }
});
`;

/**
 * Everything `packages/i18n` ships: the manifest (the one package that declares a dependency),
 * the shared shape files with the extra `catalogs/**` include the JSON needs, the typed index,
 * its test, and the flat `en` catalog. `merge: 'json'` on the catalog is what lets `x g resource
 * post` (the example slice, under `--example`) land its own keys in this same file instead of
 * `dedupe()` dropping one contributor's — see the comment on `i18nCatalog` above.
 */
export function i18nFiles(app: NameSet, version: string): readonly GeneratedFile[] {
  return [
    { path: 'packages/i18n/package.json', contents: i18nPackage(app, version) },
    ...packageShapeFiles(app, 'i18n', 'Flat catalogs with loud misses', [
      '**/*.ts',
      'catalogs/**/*',
    ]),
    { path: 'packages/i18n/src/index.ts', contents: i18nIndex(['en']) },
    { path: 'packages/i18n/src/index.test.ts', contents: i18nTest() },
    { path: 'packages/i18n/catalogs/en.json', contents: i18nCatalog(app), merge: 'json' },
  ];
}
