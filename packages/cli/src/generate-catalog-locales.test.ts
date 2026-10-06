// What `x g` does to the catalogs of locales that are not the default: a non-default locale's keys
// arrive MARKED, as `x i18n add`/`sync` mark them, and a locale with no catalog yet is refused
// with `x i18n add <locale>` rather than started as a file holding only the generator's keys.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(); the fixture app lives outside the checkout.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { loadCatalog } from '@ultimat3/i18n';
import { generate } from './cmd-generate';
import { localiseCatalogs } from './generate-catalog-locales';
import type { GeneratedFile } from './templates';
import { thrownByAsync } from './thrown-by-fixture';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-g-locales-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writeCatalog = (locale: string, catalog: Record<string, unknown>): Promise<number> =>
  Bun.write(join(root, `packages/i18n/catalogs/${locale}.json`), JSON.stringify(catalog));

const catalogIn = (files: readonly GeneratedFile[], locale: string): Record<string, string> => {
  const file = files.find((entry) => entry.path === `packages/i18n/catalogs/${locale}.json`);
  if (file?.merge !== 'json') return {};
  return { ...loadCatalog(JSON.parse(file.contents)) };
};

const resource = (locales: readonly string[]): readonly GeneratedFile[] =>
  generate({ kind: 'resource', name: 'coupon', locales });

describe('unit · catalogs a generator writes for a non-default locale', () => {
  test('a non-default locale gets every key marked, never bare English', async () => {
    await writeCatalog('en', { app: { title: 'Home' } });
    await writeCatalog('es', { app: { title: 'Inicio' } });
    const files = await localiseCatalogs(root, resource(['en', 'es']));
    const en = catalogIn(files, 'en');
    const es = catalogIn(files, 'es');
    expect(en['app.coupon.empty']).toBe('No coupons yet.');
    // The default locale's string, inside the one placeholder marker `x i18n check` counts as
    // missing — the same seed `x i18n add es` writes.
    expect(es['app.coupon.empty']).toBe('⟦No coupons yet.⟧');
    expect(Object.keys(es).toSorted()).toEqual(Object.keys(en).toSorted());
    expect(Object.values(es).every((value) => value.startsWith('⟦'))).toBe(true);
  });

  test('the declared default is the one left bare, whichever it is', async () => {
    await writeCatalog('en', {});
    await writeCatalog('es', {});
    await Bun.write(
      join(root, 'app.config.ts'),
      "export const config = { name: 'shop', locales: ['es', 'en'], defaultLocale: 'es' };\n",
    );
    const files = await localiseCatalogs(root, resource(['en', 'es']));
    expect(catalogIn(files, 'es')['app.coupon.empty']).toBe('No coupons yet.');
    expect(catalogIn(files, 'en')['app.coupon.empty']).toBe('⟦No coupons yet.⟧');
  });

  test('a locale with no catalog yet is refused with the command that adds one', async () => {
    await writeCatalog('en', { app: { title: 'Home' } });
    const failure = await thrownByAsync(() => localiseCatalogs(root, resource(['en', 'es'])));
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.cause).toContain('packages/i18n/catalogs/es.json');
    expect(failure.fix).toBe('x i18n add es');
  });

  test('an app with no catalog at all starts every locale together, the extra ones marked', async () => {
    const files = await localiseCatalogs(root, resource(['en', 'es']));
    expect(catalogIn(files, 'en')['app.coupon.empty']).toBe('No coupons yet.');
    expect(catalogIn(files, 'es')['app.coupon.empty']).toBe('⟦No coupons yet.⟧');
  });

  test('a default-only run is returned untouched', async () => {
    await writeCatalog('en', {});
    const files = resource(['en']);
    expect(await localiseCatalogs(root, files)).toEqual(files);
  });
});
