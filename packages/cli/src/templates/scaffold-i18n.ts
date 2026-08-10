// The generated app's `packages/i18n`: one flat catalog file per locale, and the framework's one
// blessed typed-catalog shape (modelled on examples/dummy/packages/i18n/src/index.ts) — split out
// of scaffold-repo.ts to stay under the file-size ceiling.

import type { GeneratedFile, NameSet } from './naming';
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

const i18nIndex =
  (): string => `// The app's catalog, registered once and typed against English. Every surface resolves strings
// through this module, and an unknown key is a compile error via useT() — never a runtime miss
// nobody notices until production.

import {
  defineCatalogs,
  type TranslationKey as KeyOf,
  type Translator,
  useI18n,
} from '@ultimat3/i18n';
import en from '../catalogs/en.json';

export const catalogs = defineCatalogs({ default: 'en', locales: { en } });

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
    { path: 'packages/i18n/src/index.ts', contents: i18nIndex() },
    { path: 'packages/i18n/src/index.test.ts', contents: i18nTest() },
    { path: 'packages/i18n/catalogs/en.json', contents: i18nCatalog(app), merge: 'json' },
  ];
}
