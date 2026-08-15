// The i18n catalogs a `x g` run writes: which locales get a file, how two generators contributing
// to one locale merge, and which locale strings are refused outright. Split from the emitted-output
// tests because a catalog is read back through `@ultimat3/i18n` rather than asserted as text — that
// reader IS the assertion, so these tests need a vocabulary the others do not.

import { describe, expect, test } from 'bun:test';
import { catalogKeys, loadCatalog } from '@ultimat3/i18n';
import { generate } from './cmd-generate';
import { thrownBy } from './thrown-by';

/**
 * A generated catalog read exactly as the app reads it. `loadCatalog` is the assertion, not a
 * convenience: it refuses the flat dot-key form, so a generator that emitted one would fail every
 * catalog test here instead of shipping a file that only breaks at the app's first boot.
 */
const catalogOf = (contents: string | undefined): Record<string, string> => ({
  ...loadCatalog(JSON.parse(contents ?? '{}')),
});
const catalogKeysOf = (contents: string | undefined): string[] => catalogKeys(catalogOf(contents));

describe('unit · the catalogs x g writes', () => {
  test('a route ships an i18n catalog entry rather than a hardcoded string', () => {
    const files = generate({ kind: 'route', name: 'pricing', surface: 'site' });
    const catalog = files.find((file) => file.path.endsWith('.json'));
    expect(catalog?.path).toBe('packages/i18n/catalogs/en.json');
    const page = files.find((file) => file.path.endsWith('page.tsx'));
    expect(page?.contents).toContain("t('app.pricing.title')");
  });

  test('a resource ships the card and form components, and their i18n keys', () => {
    const files = generate({ kind: 'resource', name: 'invoice' });
    const paths = files.map((file) => file.path);
    expect(paths).toContain('apps/web/app/invoice/ui/invoice-card.tsx');
    expect(paths).toContain('apps/web/app/invoice/ui/invoice-form.tsx');
    const catalog = files.find((file) => file.path === 'packages/i18n/catalogs/en.json');
    expect(catalogKeysOf(catalog?.contents)).toContain('app.invoice.empty');
  });

  test('a resource takes every configured locale, merging the slice and its route into one file', () => {
    const files = generate({ kind: 'resource', name: 'invoice', locales: ['en', 'es'] });
    const paths = files.map((file) => file.path);
    const catalogPaths = paths.filter((path) => path.startsWith('packages/i18n/catalogs/'));
    // Exactly one file per locale: resourceFiles' own catalogSource and the routeFiles call inside
    // it both target packages/i18n/catalogs/<locale>.json, and dedupe() merges rather than dupes.
    expect(catalogPaths.toSorted()).toEqual([
      'packages/i18n/catalogs/en.json',
      'packages/i18n/catalogs/es.json',
    ]);
    for (const locale of ['en', 'es']) {
      const catalog = files.find((file) => file.path === `packages/i18n/catalogs/${locale}.json`);
      const keys = catalogKeysOf(catalog?.contents);
      // The slice's own key (catalogSource) and the route's (routeFiles, for the /invoices page)
      // both survive the merge — this is the union, not whichever generator happened to run first.
      // Both live under `app`, so a shallow spread would keep exactly one of them.
      expect(keys).toContain('app.invoice.empty');
      expect(keys).toContain('app.invoices.title');
    }
  });

  test('a route takes the configured locales too, not just a resource', () => {
    const files = generate({
      kind: 'route',
      name: 'pricing',
      surface: 'site',
      locales: ['en', 'es'],
    });
    const paths = files.map((file) => file.path);
    expect(paths).toContain('packages/i18n/catalogs/en.json');
    expect(paths).toContain('packages/i18n/catalogs/es.json');
  });

  test('the catalog carries the admin title key the admin override resolves', () => {
    // Emitted whether or not --admin was passed: an unused key is only reported, a missing one
    // renders ⟦key⟧ and fails the i18n gate the moment someone writes the override by hand.
    for (const admin of [false, true]) {
      const files = generate({ kind: 'resource', name: 'invoice', admin });
      const catalog = files.find((file) => file.path === 'packages/i18n/catalogs/en.json');
      expect(catalogOf(catalog?.contents)['admin.invoice.title']).toBe('Invoices');
    }
    const withAdmin = generate({ kind: 'resource', name: 'invoice', admin: true });
    const override = withAdmin.find((file) => file.path.endsWith('admin/resource.ts'));
    expect(override?.contents).toContain("titleKey: 'admin.invoice.title'");
  });

  test('a locale that is really a path never becomes a catalog file', () => {
    const failure = thrownBy(() =>
      generate({ kind: 'resource', name: 'invoice', locales: ['../../../../tmp'] }),
    );
    expect(failure.code).toBe('X_SCAFFOLD_PATH_ESCAPE');
    expect(failure.fix).toBe('x g resource <name> --locales=en,es');
    // Same guard on the route generator, which owns the other half of the catalogs.
    expect(thrownBy(() => generate({ kind: 'route', name: 'pricing', locales: ['..'] })).code).toBe(
      'X_SCAFFOLD_PATH_ESCAPE',
    );
  });

  test('a locale that is not a BCP-47 tag is refused rather than silently dropped', () => {
    const failure = thrownBy(() =>
      generate({ kind: 'resource', name: 'invoice', locales: ['en_US'] }),
    );
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.cause).toContain('en_US');
  });

  test('locales are canonicalized and deduped once, for every catalog a run emits', () => {
    const files = generate({
      kind: 'resource',
      name: 'invoice',
      locales: [' EN ', 'en', 'zh-Hant'],
    });
    const catalogs = files
      .map((file) => file.path)
      .filter((path) => path.startsWith('packages/i18n/catalogs/'));
    expect(catalogs.toSorted()).toEqual([
      'packages/i18n/catalogs/en.json',
      'packages/i18n/catalogs/zh-hant.json',
    ]);
  });
});
