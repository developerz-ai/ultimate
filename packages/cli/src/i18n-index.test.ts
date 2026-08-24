// `x i18n add <locale>` used to write a catalog and stop — leaving the app's own index saying
// `locales: { en }`, `x verify --only i18n` red with `X_CATALOG_UNREGISTERED`, and a `fix:` naming
// an edit that had already been made. Two halves are asserted here: the index is re-derived from
// the catalogs on disk, and the refusal an app can still reach names a command that repairs it.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogLocales, I18N_INDEX_PATH, syncI18nIndex } from './i18n-index';
import { unregisteredFix } from './i18n-registration';
import { i18nIndex } from './templates';

const roots: string[] = [];

const appRoot = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'x-i18n-index-'));
  roots.push(dir);
  await Bun.write(join(dir, 'packages/i18n/catalogs/en.json'), '{"nav":{"home":"Home"}}\n');
  await Bun.write(join(dir, I18N_INDEX_PATH), i18nIndex(['en']));
  return dir;
};

afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('unit · adding a locale registers it', () => {
  test('a catalog on disk that the index does not name is what syncI18nIndex closes', async () => {
    const root = await appRoot();
    const before = await Bun.file(join(root, I18N_INDEX_PATH)).text();
    expect(before).not.toContain('catalogs/fr.json');

    await Bun.write(join(root, 'packages/i18n/catalogs/fr.json'), '{"nav":{"home":"Accueil"}}\n');
    expect(await syncI18nIndex(root)).toBe(true);

    const after = await Bun.file(join(root, I18N_INDEX_PATH)).text();
    expect(after).toContain("import fr from '../catalogs/fr.json';");
    expect(after).toContain('locales: { en, fr }');
  });

  test('the FULL set is re-derived, never only the locale one run asked for', async () => {
    const root = await appRoot();
    await Bun.write(join(root, 'packages/i18n/catalogs/es.json'), '{}\n');
    await Bun.write(join(root, 'packages/i18n/catalogs/fr.json'), '{}\n');
    expect(await catalogLocales(root)).toEqual(['en', 'es', 'fr']);
    await syncI18nIndex(root);
    expect(await Bun.file(join(root, I18N_INDEX_PATH)).text()).toContain('locales: { en, es, fr }');
  });

  test('an app with no i18n package is left alone and says so', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'x-i18n-index-'));
    roots.push(dir);
    expect(await syncI18nIndex(dir)).toBe(false);
  });
});

describe('unit · X_CATALOG_UNREGISTERED branches on why', () => {
  test('a locale absent from a real index gets a fix that performs the registration', () => {
    const fix = unregisteredFix('fr', i18nIndex(['en'])).fix ?? '';
    expect(fix).toContain('x i18n sync fr');
  });

  test('a locale the index already names keeps the package’s own move-the-call fix', () => {
    expect(unregisteredFix('fr', i18nIndex(['en', 'fr']))).toEqual({});
  });

  test('an app with no index keeps it too — there is nothing to re-derive', () => {
    expect(unregisteredFix('fr', undefined)).toEqual({});
  });

  test('a tag that appears inside another word is not read as registered', () => {
    // `en` is a substring of `Accueil`-free generated code but of plenty of identifiers; the match
    // is on the import path the generator writes, which is the only unambiguous spelling.
    expect(unregisteredFix('en', "const key = 'entry';\n")?.fix).toContain('x i18n sync en');
  });
});
