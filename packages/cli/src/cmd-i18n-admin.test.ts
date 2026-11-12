// `x i18n` over the keys a mounted admin DERIVES: no source file spells one, so the source scan
// never seeded them and `x i18n sync en` — `X_CATALOG_MISSING_KEYS`' own fix — added 0 keys and
// exited 0 over a red check. Here the finding's printed fix is run verbatim and the check is green.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no temporary-directory or recursive-delete API; node:fs is the only one.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { clearAdminMounts, defineAdmin } from '@ultimat3/admin';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { loadCatalog, registerCatalog, resetCatalogs } from '@ultimat3/i18n';
import { clearRoutes } from '@ultimat3/render';
import { adminKeyLabel } from './admin-catalog-keys';
import { REQUIRED_BUN } from './app-root';
import { i18nCommand } from './cmd-i18n';
import type { CommandContext } from './command';
import { msg } from './messages';
import { parseArgs } from './parse';

let root = '';

const widgets = entity('cli_i18n_widgets', {
  columns: { id: uuid().primaryKey(), title: text({ max: 80 }), createdBy: text({ max: 80 }) },
});

/** A real app root whose `en` catalog answers every key source names and none the admin derives. */
async function seedApp(): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'x-i18n-admin-'));
  await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  mkdirSync(join(root, 'node_modules/@ultimat3'), { recursive: true });
  symlinkSync(join(import.meta.dir, '../../i18n'), join(root, 'node_modules/@ultimat3/i18n'));
  await Bun.write(join(root, 'app/page.ts'), "t('greeting');\n");
  await Bun.write(join(root, 'packages/i18n/catalogs/en.json'), '{ "greeting": "Hello" }\n');
  await Bun.write(
    join(root, 'packages/i18n/src/index.ts'),
    [
      "import { defineCatalogs } from '@ultimat3/i18n';",
      "import en from '../catalogs/en.json';",
      "export const catalogs = defineCatalogs({ default: 'en', locales: { en } });",
      '',
    ].join('\n'),
  );
  defineAdmin({
    basePath: '/i18n-admin',
    entities: [widgets],
    db: database({ widgets }, { driver: memoryDriver() }),
  });
  return root;
}

/** The temp module cache answers the first import forever, so the file is registered by hand. */
async function registerEn(appRoot: string): Promise<void> {
  const parsed: unknown = await Bun.file(join(appRoot, 'packages/i18n/catalogs/en.json')).json();
  registerCatalog('en', loadCatalog(parsed));
}

function contextFor(appRoot: string, args: readonly string[]): CommandContext {
  return {
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
  };
}

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
  resetCatalogs();
  clearAdminMounts();
  clearRoutes();
  clearRegistry();
});

describe('unit · x i18n over a mounted admin’s derived keys', () => {
  test('check counts the admin keys it fails on — never "0 missing" over ok: false', async () => {
    const appRoot = await seedApp();
    await registerEn(appRoot);
    const result = await i18nCommand.run(contextFor(appRoot, ['check']));

    expect(result.ok).toBe(false);
    const finding = result.findings?.find((f) => f.code === 'X_CATALOG_MISSING_KEYS');
    expect(finding?.cause).toContain('admin.cli_i18n_widgets.field.createdBy');
    // Every key the cause lists is one the count includes: the summary and `ok` judge one set.
    const listed = (finding?.cause.match(/"admin\.[^"]+"/g) ?? []).length;
    expect(listed).toBeGreaterThan(0);
    expect(result.summary).toBe(msg('cli.i18n.gaps', { missing: listed, locales: 1 }));
  });

  test('the registered fix, run verbatim, writes the labels nested and turns check green', async () => {
    const appRoot = await seedApp();
    await registerEn(appRoot);
    const before = await i18nCommand.run(contextFor(appRoot, ['check']));
    expect(before.ok).toBe(false);

    // The command half of the admin finding's own `fix:` — `x i18n sync en   # …` — as printed.
    const printed = before.findings?.find(
      (f) => f.code === 'X_CATALOG_MISSING_KEYS' && f.cause.includes('mounted admin'),
    );
    const command = printed?.fix.split('#')[0]?.trim() ?? '';
    expect(command).toBe('x i18n sync en');
    const [bin, ...args] = command.split(/\s+/);
    expect(bin).toBe('x');
    const synced = await i18nCommand.run(contextFor(appRoot, args.slice(1)));
    expect(synced.ok).toBe(true);
    expect((synced.data as { added: readonly string[] }).added).toContain(
      'admin.cli_i18n_widgets.field.createdBy',
    );

    // Nested on disk — the shape `loadCatalog` accepts — and labelled as the generator labels.
    const raw: unknown = await Bun.file(join(appRoot, 'packages/i18n/catalogs/en.json')).json();
    expect(raw).toMatchObject({
      admin: { cli_i18n_widgets: { field: { createdBy: 'Created by' } } },
    });

    await registerEn(appRoot);
    const after = await i18nCommand.run(contextFor(appRoot, ['check']));
    expect(after.findings).toEqual([]);
    expect(after.ok).toBe(true);
  });
});

describe('unit · the label sync writes for an admin key', () => {
  test('reads the thing labelled, never the slot it fills', () => {
    expect(adminKeyLabel('admin.posts.field.createdAt')).toBe('Created at');
    expect(adminKeyLabel('admin.posts.title')).toBe('Posts');
    expect(adminKeyLabel('admin.group.data')).toBe('Data');
    expect(adminKeyLabel('admin.orgs.field.orgId')).toBe('Org ID');
  });
});
