// `x i18n add <locale>` used to write a catalog and stop — leaving the app's own index saying
// `locales: { en }`, `x verify --only i18n` red with `X_CATALOG_UNREGISTERED`, and a `fix:` naming
// an edit that had already been made. Two halves are asserted here: the index is re-derived from
// the catalogs on disk, and the refusal an app can still reach names a command that repairs it.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
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
    expect((await syncI18nIndex(root)).registered).toBe(true);

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
    expect((await syncI18nIndex(dir)).registered).toBe(false);
  });
});

// Row p: the index was OVERWRITTEN with the template on every `x g` and `x i18n add|sync` — a
// hand-set `default: 'es'` became `'en'`, hand-written code vanished, and an app with no `en.json`
// got an import of one.
describe('unit · a hand-edited index is edited, never replaced', () => {
  const HAND = [
    "import { defineCatalogs } from '@ultimat3/i18n';",
    "import es from '../catalogs/es.json';",
    '',
    "export const catalogs = defineCatalogs({ default: 'es', locales: { es } });",
    'export const mine = 1; // the author wrote this',
    '',
  ].join('\n');

  test('a missing locale is added beside the others; the default and the rest survive', async () => {
    const root = await appRoot();
    await rm(join(root, 'packages/i18n/catalogs/en.json'));
    await Bun.write(join(root, 'packages/i18n/catalogs/es.json'), '{}\n');
    await Bun.write(join(root, 'packages/i18n/catalogs/fr.json'), '{}\n');
    await Bun.write(join(root, I18N_INDEX_PATH), HAND);

    const sync = await syncI18nIndex(root);

    expect(sync).toEqual({ registered: true, findings: [] });
    const after = await Bun.file(join(root, I18N_INDEX_PATH)).text();
    expect(after).toContain("import fr from '../catalogs/fr.json';");
    expect(after).toContain("defineCatalogs({ default: 'es', locales: { es, fr } })");
    expect(after).toContain('export const mine = 1; // the author wrote this');
    expect(after).not.toContain('en.json');
  });

  test('a shape this writer cannot edit is refused with the edit named, and left untouched', async () => {
    const root = await appRoot();
    const odd = "export { catalogs } from './elsewhere';\n";
    await Bun.write(join(root, I18N_INDEX_PATH), odd);
    await Bun.write(join(root, 'packages/i18n/catalogs/fr.json'), '{}\n');

    const sync = await syncI18nIndex(root);

    expect(sync.registered).toBe(false);
    expect(sync.findings.map((finding) => finding.code)).toEqual(['X_CATALOG_UNREGISTERED']);
    expect(sync.findings[0]?.fix).toContain("import fr from '../catalogs/fr.json'");
    expect(await Bun.file(join(root, I18N_INDEX_PATH)).text()).toBe(odd);
  });

  test('the template never imports an en.json the catalogs do not hold', () => {
    const source = i18nIndex(['es', 'fr']);
    expect(source).not.toContain('en.json');
    expect(source).toContain("defineCatalogs({ default: 'es', locales: { es, fr } })");
    expect(source).toContain('export type AppCatalog = typeof es;');
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
