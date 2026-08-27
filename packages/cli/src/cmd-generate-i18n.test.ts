// Split out of cmd-generate.test.ts to stay under the file-size ceiling: both halves guard the
// same fact (a generated locale catalog is worthless if nothing ever teaches the app to import
// it), one at the pure `dedupe()` level and one through the real `x g` command end to end.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { resetAppLoad } from './app-load';
import { dedupe, generateCommand } from './cmd-generate';
import type { CommandContext } from './command';
import type { GeneratedFile } from './templates';
import { thrownBy } from './thrown-by';

// `dedupe()` is where every `generate()` call and `x new`'s `planNewApp()` funnel their file list
// through before a single byte reaches disk — so a generator's own template bug is caught here,
// synchronously, rather than reaching `writeFiles`/`mergeJsonFile` and silently contributing `{}`.
describe('unit · dedupe rejects a merge: json file a generator could not have meant', () => {
  test('a single unparseable contributor throws rather than silently writing {}', () => {
    const bad: GeneratedFile = {
      path: 'packages/i18n/catalogs/en.json',
      contents: 'not json{',
      merge: 'json',
    };
    const failure = thrownBy(() => dedupe([bad]));
    expect(failure.code).toBe('X_GENERATE_JSON_INVALID');
    expect(failure.cause).toContain('packages/i18n/catalogs/en.json');
    expect(failure.fix).toContain('packages/i18n/catalogs/en.json');
  });

  test('a malformed second contributor throws instead of vanishing from the merge', () => {
    const good: GeneratedFile = {
      path: 'packages/i18n/catalogs/en.json',
      contents: JSON.stringify({ 'app.invoice.empty': 'No invoices yet.' }),
      merge: 'json',
    };
    const bad: GeneratedFile = {
      path: 'packages/i18n/catalogs/en.json',
      contents: 'not json{',
      merge: 'json',
    };
    // Whichever generator's output arrives second, the bad one is never the one that silently
    // loses — dedupe validates every contributor, not just the first or the one already stored.
    expect(thrownBy(() => dedupe([good, bad])).code).toBe('X_GENERATE_JSON_INVALID');
    expect(thrownBy(() => dedupe([bad, good])).code).toBe('X_GENERATE_JSON_INVALID');
  });

  test('a plain (non-merge) duplicate is untouched by the json check', () => {
    const files: GeneratedFile[] = [
      { path: 'apps/web/app/invoice/errors.ts', contents: 'export {};' },
      { path: 'apps/web/app/invoice/errors.ts', contents: 'not json{' },
    ];
    // No `merge: 'json'` anywhere in the pair, so first-write-wins applies exactly as before —
    // the second file's unparseable-as-JSON text is irrelevant, because nothing here reads it as
    // JSON in the first place.
    // `files.slice(0, 1)`, not `[files[0]]`: an index read is `GeneratedFile | undefined` under
    // `noUncheckedIndexedAccess`, and the slice says "the first file, unchanged" without it.
    expect(dedupe(files)).toEqual(files.slice(0, 1));
  });
});

// A locale's catalog file existing on disk and the app being able to select that locale used to be
// two different facts: `packages/i18n/src/index.ts` was written once, at `x new` time, importing
// only the locales that existed then, and nothing afterwards ever taught it about a locale a later
// `x g ... --locales` added. This pins the fix end to end, through the real command handler — a
// pure-function check of `i18nIndex()` alone (see `templates/scaffold-i18n.test.ts`) could not have
// caught the original bug, which was entirely about nothing ever calling it again after scaffold time.
describe('unit · x g regenerates the app catalog index for every locale on disk', () => {
  // Under `packages/cli/`, same as the manifest fixture in cmd-generate.test.ts, and its own
  // directory so the two fixtures' independent beforeAll/afterAll never race each other.
  const ROOT = join(import.meta.dir, '..', '.generate-i18n-fixture');
  const INDEX_PATH = join(ROOT, 'packages/i18n/src/index.ts');

  const contextFor = (locales: string): CommandContext => ({
    args: {
      command: 'g',
      subcommand: undefined,
      positionals: ['route', 'pricing'],
      flags: new Map([['locales', locales]]),
      json: false,
      help: false,
      passthrough: [],
    },
    cwd: ROOT,
    runner: async () => ({
      command: ['true'],
      code: 0,
      ok: true,
      stdout: '',
      stderr: '',
      durationMs: 0,
    }),
    env: {},
    bunVersion: '1.3.0',
  });

  const seedApp = async (): Promise<void> => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(join(ROOT, 'app.config.ts'), `export const config = { name: 'gen-i18n' };\n`);
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'generate-i18n-fixture', version: '1.0.0' }),
    );
    // The exact scaffold-time shape `i18nFiles`/`i18nIndex(['en'])` writes at `x new` — one locale.
    await Bun.write(
      INDEX_PATH,
      [
        "import { defineCatalogs } from '@ultimat3/i18n';",
        "import en from '../catalogs/en.json';",
        '',
        "export const catalogs = defineCatalogs({ default: 'en', locales: { en } });",
        '',
      ].join('\n'),
    );
    await Bun.write(
      join(ROOT, 'packages/i18n/catalogs/en.json'),
      `${JSON.stringify({ 'app.pricing.title': 'Pricing' }, null, 2)}\n`,
    );
    resetAppLoad();
  };

  beforeAll(seedApp);

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    resetAppLoad();
  });

  test('a new --locales catalog is imported and registered, not just written to disk', async () => {
    const result = await generateCommand.run(contextFor('es'));
    expect((result.data as { files?: readonly string[] }).files).toContain(
      'packages/i18n/catalogs/es.json',
    );
    const indexSource = await Bun.file(INDEX_PATH).text();
    // The old (unfixed) behaviour never touches this file after scaffold time, so this is exactly
    // the assertion that would fail against it: the seeded content above has no `es` anywhere.
    expect(indexSource).toContain("import es from '../catalogs/es.json';");
    expect(indexSource).toContain('locales: { en, es }');
    // The pre-existing `en` registration survives the regeneration, not just gains a neighbour.
    expect(indexSource).toContain("import en from '../catalogs/en.json';");
  });

  test('an app with no i18n package is left alone', async () => {
    await seedApp();
    await rm(join(ROOT, 'packages/i18n'), { recursive: true, force: true });
    const result = await generateCommand.run(contextFor('es'));
    expect((result.data as { files?: readonly string[] }).files).toContain(
      'packages/i18n/catalogs/es.json',
    );
    // `x g` still writes the catalog a route or resource asked for; it just never fabricates the
    // index file for an app that has no `packages/i18n/src/index.ts` to regenerate.
    expect(await Bun.file(INDEX_PATH).exists()).toBe(false);
  });
});
