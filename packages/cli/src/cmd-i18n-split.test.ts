// `x i18n` over split catalogs, through the real command and parser: `split` moves flat files into
// namespace files losslessly and idempotently, the app still registers every key through the
// barrel, `sync` and `add` write into the split form, and a mixed locale or a key two files define
// is refused with its own code.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no temporary-directory, symlink or recursive-delete API; `node:os` is the only
// answer to the platform temp root and `node:path` the only path join.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetCatalogs } from '@ultimat3/i18n';
import { REQUIRED_BUN } from './app-root';
import { i18nCommand } from './cmd-i18n';
import type { CommandContext } from './command';
import { loadCatalogs } from './i18n-audit';
import { parseArgs } from './parse';
import { i18nIndex } from './templates';
import { rootGitattributes } from './templates/scaffold-gitattributes';
import type { ThrownShape } from './thrown-by-fixture';

let root = '';

const EN = {
  billing: { plans: { pro: 'Pro', free: 'Free' } },
  site: { home: { title: 'Home' }, footer: 'Built here' },
};
const ES = { billing: { plans: { pro: 'Pro', free: 'Gratis' } }, site: { footer: 'Hecho aquí' } };

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** A flat app: `en` and `es`, the generated index, the merge rules `x new` wrote before split. */
async function seedApp(): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'x-i18n-split-'));
  await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  mkdirSync(join(root, 'node_modules/@ultimat3'), { recursive: true });
  symlinkSync(join(import.meta.dir, '../../i18n'), join(root, 'node_modules/@ultimat3/i18n'));
  await Bun.write(
    join(root, 'app/page.ts'),
    "t('billing.plans.pro'); t('billing.plans.free'); t('site.home.title'); t('site.footer');\n",
  );
  await Bun.write(join(root, 'packages/i18n/catalogs/en.json'), json(EN));
  await Bun.write(join(root, 'packages/i18n/catalogs/es.json'), json(ES));
  await Bun.write(join(root, 'packages/i18n/src/index.ts'), i18nIndex(['en', 'es']));
  const legacy = rootGitattributes().replace(
    'packages/i18n/catalogs/**/*.json merge=x-registry\npackages/i18n/catalogs/*/index.ts merge=x-registry',
    'packages/i18n/catalogs/*.json merge=x-registry',
  );
  await Bun.write(join(root, '.gitattributes'), legacy);
  return root;
}

const contextFor = (appRoot: string, args: readonly string[]): CommandContext => ({
  args: parseArgs(['i18n', ...args], [i18nCommand.spec]),
  cwd: appRoot,
  runner: () =>
    Promise.resolve({
      command: ['true'],
      code: 0,
      ok: true,
      stdout: '',
      stderr: '',
      durationMs: 0,
    }),
  env: {},
  bunVersion: REQUIRED_BUN,
});

const run = (args: readonly string[]) => i18nCommand.run(contextFor(root, args));
const read = (path: string): Promise<string> => Bun.file(join(root, path)).text();
const at = (path: string): string => join(root, 'packages/i18n/catalogs', path);

async function rejectedBy(call: () => Promise<unknown>): Promise<ThrownShape> {
  try {
    await call();
  } catch (error) {
    return error as ThrownShape;
  }
  return expect.unreachable('expected a rejection');
}

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
  resetCatalogs();
});

describe('unit · x i18n split', () => {
  test('flat → one file per namespace, losslessly, the flat files gone', async () => {
    await seedApp();
    const before = await loadCatalogs(root);
    const result = await run(['split']);
    expect(result.ok).toBe(true);
    expect(existsSync(at('en.json'))).toBe(false);
    expect(existsSync(at('es.json'))).toBe(false);
    expect(await Bun.file(at('en/billing.json')).json()).toEqual(EN.billing);
    expect(await Bun.file(at('en/site.json')).json()).toEqual(EN.site);
    expect(await Bun.file(at('es/site.json')).json()).toEqual(ES.site);
    // Round trip: the files join back to exactly the catalogs that were split.
    expect(await loadCatalogs(root)).toEqual(before);
    expect(result.data).toMatchObject({ removed: expect.arrayContaining([expect.any(String)]) });
  });

  test('the index imports each barrel, and the barrel joins its files', async () => {
    await seedApp();
    await run(['split']);
    const index = await read('packages/i18n/src/index.ts');
    expect(index).toContain("import { catalog as en } from '../catalogs/en';");
    expect(index).toContain("import { catalog as es } from '../catalogs/es';");
    expect(index).not.toContain('.json');
    const barrel = await read('packages/i18n/catalogs/en/index.ts');
    expect(barrel).toContain("import nsBilling from './billing.json';");
    expect(barrel).toContain('  billing: nsBilling,');
    const imported = (await import(at('en/index.ts'))) as { catalog: unknown };
    expect(imported.catalog).toEqual(EN);
  });

  test('a split app registers every key through the barrel, and a gap names the directory', async () => {
    await seedApp();
    await run(['split']);
    const check = await run(['check']);
    // `es` lacks `site.home.title` on purpose: the one finding, pointed at the split locale.
    expect((check.findings ?? []).map((finding) => [finding.code, finding.at])).toEqual([
      ['X_CATALOG_MISSING_KEYS', 'packages/i18n/catalogs/es/'],
    ]);
    expect(check.data).toMatchObject({ registered: expect.arrayContaining(['en', 'es']) });
  });

  test('a second run changes nothing', async () => {
    await seedApp();
    await run(['split']);
    const barrel = await read('packages/i18n/catalogs/en/index.ts');
    const again = await run(['split']);
    expect(again.data).toMatchObject({ written: [], removed: [] });
    expect(await read('packages/i18n/catalogs/en/index.ts')).toBe(barrel);
  });

  test('one named locale moves alone, and the merge rules widen', async () => {
    await seedApp();
    await run(['split', 'es']);
    expect(existsSync(at('en.json'))).toBe(true);
    expect(existsSync(at('es/billing.json'))).toBe(true);
    const attributes = await read('.gitattributes');
    expect(attributes).toContain('packages/i18n/catalogs/**/*.json merge=x-registry');
    expect(attributes).toContain('packages/i18n/catalogs/*/index.ts merge=x-registry');
    expect(attributes).not.toContain('packages/i18n/catalogs/*.json merge=x-registry');
    const index = await read('packages/i18n/src/index.ts');
    expect(index).toContain("import en from '../catalogs/en.json';");
    expect(index).toContain("import { catalog as es } from '../catalogs/es';");
  });

  test('a nested folder is a deeper namespace, and split keeps keys in it', async () => {
    await seedApp();
    await run(['split', 'en']);
    // An author moves `site.home` into its own file by hand, then re-derives the barrel.
    await Bun.write(at('en/site.json'), json({ footer: EN.site.footer }));
    await Bun.write(at('en/site/home.json'), json(EN.site.home));
    await run(['split', 'en']);
    expect((await loadCatalogs(root))['en']).toMatchObject({ 'site.home.title': 'Home' });
    expect(await read('packages/i18n/catalogs/en/index.ts')).toContain('home: nsSiteHome,');
  });
});

describe('unit · split catalogs refuse ambiguity', () => {
  test('a locale with both forms is X_CATALOG_LAYOUT_MIXED, and split repairs it', async () => {
    await seedApp();
    await run(['split', 'en']);
    await Bun.write(at('en.json'), json({ billing: { plans: { team: 'Team' } } }));
    const refused = await rejectedBy(() => loadCatalogs(root));
    expect(refused.code).toBe('X_CATALOG_LAYOUT_MIXED');
    expect(refused.fix).toContain('x i18n split en');
    await run(['split', 'en']);
    expect(existsSync(at('en.json'))).toBe(false);
    expect(await Bun.file(at('en/billing.json')).json()).toEqual({
      plans: { ...EN.billing.plans, team: 'Team' },
    });
  });

  test('a key two files define is X_CATALOG_KEY_DUPLICATE naming both', async () => {
    await seedApp();
    await run(['split', 'en']);
    await Bun.write(at('en/site/home.json'), json({ title: 'Start' }));
    const refused = await rejectedBy(() => run(['check']));
    expect(refused.code).toBe('X_CATALOG_KEY_DUPLICATE');
    expect(refused.cause).toContain('packages/i18n/catalogs/en/site.json');
    expect(refused.cause).toContain('packages/i18n/catalogs/en/site/home.json');
  });

  test('a top-level key has no namespace to split into', async () => {
    await seedApp();
    await Bun.write(at('en.json'), json({ ...EN, greeting: 'Hi' }));
    const refused = await rejectedBy(() => run(['split', 'en']));
    expect(refused.code).toBe('X_CATALOG_INVALID');
    expect(existsSync(at('en.json'))).toBe(true);
  });
});

describe('unit · writing into split catalogs', () => {
  test('sync writes each key into its namespace file, creating one it lacks', async () => {
    await seedApp();
    await run(['split']);
    const synced = await run(['sync', 'es']);
    expect(synced.ok).toBe(true);
    expect(synced.data).toMatchObject({ added: ['site.home.title'] });
    expect(await Bun.file(at('es/site.json')).json()).toEqual({
      footer: 'Hecho aquí',
      home: { title: '⟦Home⟧' },
    });
    // A namespace `es` has never had is created, and its barrel names it.
    await Bun.write(at('en/legal.json'), json({ terms: 'Terms' }));
    await run(['split', 'en']);
    await run(['sync', 'es']);
    expect(await Bun.file(at('es/legal.json')).json()).toEqual({ terms: '⟦Terms⟧' });
    expect(await read('packages/i18n/catalogs/es/index.ts')).toContain(
      "import nsLegal from './legal.json';",
    );
  });

  test('add starts a new locale in the default locale’s split form', async () => {
    await seedApp();
    await run(['split']);
    const added = await run(['add', 'fr']);
    expect(added.ok).toBe(true);
    expect(added.data).toMatchObject({ path: 'packages/i18n/catalogs/fr/' });
    expect(existsSync(at('fr.json'))).toBe(false);
    expect(await Bun.file(at('fr/billing.json')).json()).toEqual({
      plans: { free: '⟦Free⟧', pro: '⟦Pro⟧' },
    });
    expect(await read('packages/i18n/src/index.ts')).toContain(
      "import { catalog as fr } from '../catalogs/fr';",
    );
    const again = await rejectedBy(() => run(['add', 'fr']));
    expect(again.code).toBe('X_GENERATE_CONFLICT');
  });
});
