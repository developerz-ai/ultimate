// End-to-end coverage for `x i18n` through the real command and the real parser: a missing key
// fails `check`, `sync` closes the gap without touching an existing translated value, `add`
// refuses to clobber a catalog and seeds a new one from the resolved default locale, and a
// malformed locale or a missing positional is refused before any file is touched.
// The command is imported directly rather than dispatched through `registry.ts`, so a failure here
// names this command and not the router — `ParsedArgs` still comes from the real `parseArgs`.

import { afterEach, describe, expect, test } from 'bun:test';
// `node:` and not Bun: Bun has no API for a temporary directory (`mkdtempSync` + `tmpdir`) and none
// for a recursive delete (`rmSync`). `node:path` comes with them — `Bun.write` takes the joined
// path, but only `node:path` can build one.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Catalog } from '@ultimat3/i18n';
import { loadCatalog } from '@ultimat3/i18n';
import { I18N_SUBCOMMANDS, i18nCommand } from './cmd-i18n';
import type { CommandContext } from './command';
import { msg } from './messages';
import { parseArgs } from './parse';
import type { ThrownShape } from './thrown-by';

let root = '';

/**
 * A real app root: `app.config.ts` marker, one source file using two keys, and two catalogs — `en`
 * complete (plus one key nothing uses), `es` missing `farewell` and carrying a `greeting` whose
 * value differs from `en`'s, so `sync` has both a gap to close and a value it must not touch.
 * Both catalogs nest a `nav` branch, `es` with only one of its two leaves: a catalog whose leaves
 * were all top-level would pass every assertion below even if the merge went shallow.
 */
async function seedApp(): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'x-i18n-cmd-'));
  await Bun.write(join(root, 'app.config.ts'), 'export const config = {};\n');
  await Bun.write(join(root, 'app/page.ts'), "t('greeting'); t('farewell');\n");
  await Bun.write(
    join(root, 'packages/i18n/catalogs/en.json'),
    `${JSON.stringify(
      {
        greeting: 'Hello',
        farewell: 'Bye',
        extra: 'Unused key',
        nav: { home: 'Home', about: 'About' },
      },
      null,
      2,
    )}\n`,
  );
  await Bun.write(
    join(root, 'packages/i18n/catalogs/es.json'),
    `${JSON.stringify({ greeting: 'Hola distinta', nav: { home: 'Inicio' } }, null, 2)}\n`,
  );
  await Bun.write(
    join(root, 'packages/i18n/src/index.ts'),
    [
      "import { defineCatalogs } from '@ultimat3/i18n';",
      "export const catalogs = defineCatalogs({ default: 'en', locales: { en, es } });",
      '',
    ].join('\n'),
  );
  return root;
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
    bunVersion: '1.3.0',
  };
}

/**
 * The catalog as the framework reads it: `loadCatalog` validates the nested file and flattens it to
 * dot keys, so a malformed value fails here instead of being laundered by a type assertion — and
 * `nav.about` below is the key an assertion can name.
 */
async function readCatalog(path: string): Promise<Catalog> {
  const parsed: unknown = await Bun.file(path).json();
  return loadCatalog(parsed);
}

/** `run()` rejects, it never returns an `ok: false` result for a bad flag or a conflict. */
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
});

describe('unit · x i18n spec', () => {
  test('names all three subcommands, check first, and requires an app', () => {
    expect(I18N_SUBCOMMANDS).toEqual(['check', 'add', 'sync']);
    expect(i18nCommand.spec.subcommands).toBe(I18N_SUBCOMMANDS);
    expect(i18nCommand.spec.name).toBe('i18n');
    expect(i18nCommand.spec.requiresApp).toBe(true);
    expect(i18nCommand.spec.summary).toBe('catalogs: add a locale, sync keys, check for gaps');
    expect(i18nCommand.spec.usage).toBe('x i18n [check|add <locale>|sync <locale>] [--json]');
  });
});

describe('unit · x i18n check', () => {
  test('a missing key fails the command with an X_CATALOG_MISSING_KEYS finding on the right file', async () => {
    const appRoot = await seedApp();
    const result = await i18nCommand.run(contextFor(appRoot, ['check']));

    expect(result.ok).toBe(false);
    expect(result.command).toBe('i18n');
    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings ?? [];
    expect(finding?.code).toBe('X_CATALOG_MISSING_KEYS');
    expect(finding?.at).toBe('packages/i18n/catalogs/es.json');
    expect(finding?.cause).toContain('farewell');
    expect(finding?.fix).toBe('x i18n sync es');
    expect(result.summary).toBe(msg('cli.i18n.gaps', { missing: 1, locales: 1 }));
  });

  test('with no subcommand, defaults to check', async () => {
    const appRoot = await seedApp();
    const result = await i18nCommand.run(contextFor(appRoot, []));
    expect(result.ok).toBe(false);
    expect(result.command).toBe('i18n');
  });

  test('reports unused keys and a clean summary once the gap is closed', async () => {
    const appRoot = await seedApp();
    await Bun.write(
      join(appRoot, 'packages/i18n/catalogs/es.json'),
      `${JSON.stringify({ greeting: 'Hola', farewell: 'Adios' }, null, 2)}\n`,
    );
    const result = await i18nCommand.run(contextFor(appRoot, ['check']));

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.summary).toBe(msg('cli.i18n.ok', { locales: 2, keys: 2 }));
    expect(result.lines?.some((line) => line.includes('extra'))).toBe(true);
  });
});

describe('unit · x i18n sync', () => {
  test('adds every key the default locale has that this one lacks, and never overwrites an existing value', async () => {
    const appRoot = await seedApp();
    const before = await readCatalog(join(appRoot, 'packages/i18n/catalogs/es.json'));
    expect(before['greeting']).toBe('Hola distinta');
    expect(before['nav.about']).toBeUndefined();

    const result = await i18nCommand.run(contextFor(appRoot, ['sync', 'es']));

    // `sync` diffs the whole catalog against the default locale, not just source-used keys — `en`
    // also has `extra` (defined, never referenced by any `t()` call), and it is missing from `es`
    // exactly the same as `farewell` is, so both are added. `nav.about` is the third: a leaf under
    // a branch `es` already has, which only a deep merge reaches.
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      msg('cli.i18n.synced', { locale: 'es', from: 'en', added: 3, total: 5 }),
    );
    expect(result.data).toEqual({
      locale: 'es',
      from: 'en',
      added: ['extra', 'farewell', 'nav.about'],
      total: 5,
      path: 'packages/i18n/catalogs/es.json',
    });

    const after = await readCatalog(join(appRoot, 'packages/i18n/catalogs/es.json'));
    expect(after['greeting']).toBe('Hola distinta');
    expect(after['farewell']).toBe('Bye');
    expect(after['extra']).toBe('Unused key');
    // The nested pair: the missing leaf arrives, the translated sibling is untouched.
    expect(after['nav.about']).toBe('About');
    expect(after['nav.home']).toBe('Inicio');
  });

  test('a second sync with nothing missing adds nothing', async () => {
    const appRoot = await seedApp();
    await i18nCommand.run(contextFor(appRoot, ['sync', 'es']));
    const result = await i18nCommand.run(contextFor(appRoot, ['sync', 'es']));
    expect((result.data as { added: readonly string[] }).added).toEqual([]);
  });

  test('a locale with no catalog on disk is refused, naming x i18n add as the fix', async () => {
    const appRoot = await seedApp();
    const thrown = await rejectedBy(() => i18nCommand.run(contextFor(appRoot, ['sync', 'de'])));
    expect(thrown).toBeUltimateError('X_CLI_BAD_FLAG');
    expect(thrown.fix).toBe('x i18n add de');
  });
});

describe('unit · x i18n add', () => {
  test('seeds a new locale from the resolved default, sorted and copied verbatim', async () => {
    const appRoot = await seedApp();
    const result = await i18nCommand.run(contextFor(appRoot, ['add', 'fr']));

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(msg('cli.i18n.added', { locale: 'fr', keys: 5, from: 'en' }));
    expect(result.data).toEqual({
      locale: 'fr',
      from: 'en',
      keys: 5,
      path: 'packages/i18n/catalogs/fr.json',
    });

    // Written nested, sorted, with the `nav` branch rebuilt from its two dot keys.
    const written = await Bun.file(join(appRoot, 'packages/i18n/catalogs/fr.json')).text();
    expect(written).toBe(
      `${JSON.stringify(
        {
          extra: 'Unused key',
          farewell: 'Bye',
          greeting: 'Hello',
          nav: { about: 'About', home: 'Home' },
        },
        null,
        2,
      )}\n`,
    );
  });

  test('refuses an existing catalog with X_GENERATE_CONFLICT rather than overwriting it', async () => {
    const appRoot = await seedApp();
    const thrown = await rejectedBy(() => i18nCommand.run(contextFor(appRoot, ['add', 'es'])));
    expect(thrown).toBeUltimateError('X_GENERATE_CONFLICT');
    expect(thrown.fix).toBe('x i18n sync es');

    const untouched = await readCatalog(join(appRoot, 'packages/i18n/catalogs/es.json'));
    expect(untouched['greeting']).toBe('Hola distinta');
  });

  test('an app with no catalogs directory yet gets one — open() creates no parent', async () => {
    const appRoot = await seedApp();
    rmSync(join(appRoot, 'packages/i18n/catalogs'), { recursive: true, force: true });

    const result = await i18nCommand.run(contextFor(appRoot, ['add', 'fr']));

    // Nothing on disk to seed from, so the catalog is empty and `from` degrades to the locale
    // itself — the file still has to exist, directory and all.
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(msg('cli.i18n.added', { locale: 'fr', keys: 0, from: 'fr' }));
    expect(await Bun.file(join(appRoot, 'packages/i18n/catalogs/fr.json')).text()).toBe('{}\n');
  });

  test('an i18n module that will not import is surfaced as a finding, not a silent fallback', async () => {
    const appRoot = await seedApp();
    const result = await i18nCommand.run(contextFor(appRoot, ['add', 'fr']));

    // The fixture lives in /tmp, where `@ultimat3/i18n` does not resolve — so the app's own
    // `defineCatalogs({ default: 'en' })` never runs and `from` above is the framework's own `en`
    // standing in for it. The write succeeded, so `ok` stays true; the finding is what says why the
    // seed locale came from the framework rather than from the app.
    expect(result.ok).toBe(true);
    expect(result.findings?.map((finding) => finding.at)).toContain('packages/i18n/src/index.ts');
  });

  test('a locale with no positional is refused before touching disk', async () => {
    const appRoot = await seedApp();
    const thrown = await rejectedBy(() => i18nCommand.run(contextFor(appRoot, ['add'])));
    expect(thrown).toBeUltimateError('X_CLI_BAD_FLAG');
  });

  test('a malformed BCP-47 locale is refused, and the fix names this command', async () => {
    const appRoot = await seedApp();
    const thrown = await rejectedBy(() => i18nCommand.run(contextFor(appRoot, ['add', '1234'])));
    expect(thrown).toBeUltimateError('X_CLI_BAD_FLAG');
    expect(thrown.fix).toBe('x i18n add es');
    // The shared validator is `x g --locales`'s; the cause has to name what this caller typed.
    expect(thrown.cause).toContain('--locale on "x i18n"');
  });
});
