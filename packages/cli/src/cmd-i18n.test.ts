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
import { loadCatalog, registerCatalog, resetCatalogs } from '@ultimat3/i18n';
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
      // The import lines matter: `i18nIndex` writes them, and they are what says a locale is
      // REGISTERED as opposed to merely present on disk — `X_CATALOG_UNREGISTERED` branches on it
      // to tell "the call is in a module nothing imports" from "this locale is not in the map".
      // A stub without them is a shape no app `x new` produced has ever had.
      "import en from '../catalogs/en.json';",
      "import es from '../catalogs/es.json';",
      "export const catalogs = defineCatalogs({ default: 'en', locales: { en, es } });",
      '',
    ].join('\n'),
  );
  return root;
}

/**
 * The half of a real boot a temp directory cannot perform: `packages/i18n/src/index.ts` there
 * cannot resolve `@ultimat3/i18n`, so nothing registers. Every test whose subject is the FILE
 * audit calls this first — without it the app is the one issue #249 reported, and the registration
 * finding is the correct answer rather than the one those tests are asking about.
 */
async function registerSeededCatalogs(appRoot: string): Promise<void> {
  for (const locale of ['en', 'es']) {
    registerCatalog(
      locale,
      await readCatalog(join(appRoot, `packages/i18n/catalogs/${locale}.json`)),
    );
  }
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
  resetCatalogs();
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
    await registerSeededCatalogs(appRoot);
    const result = await i18nCommand.run(contextFor(appRoot, ['check']));

    expect(result.ok).toBe(false);
    expect(result.command).toBe('i18n');
    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings ?? [];
    expect(finding?.code).toBe('X_CATALOG_MISSING_KEYS');
    expect(finding?.at).toBe('packages/i18n/catalogs/es.json');
    expect(finding?.cause).toContain('farewell');
    expect(finding?.fix).toBe(
      'x i18n sync es   # writes each key above as ⟦key⟧ — replace every one with the real string',
    );
    expect(result.summary).toBe(msg('cli.i18n.gaps', { missing: 1, locales: 1 }));
  });

  test('with no subcommand, defaults to check', async () => {
    const appRoot = await seedApp();
    await registerSeededCatalogs(appRoot);
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
    await registerSeededCatalogs(appRoot);
    const result = await i18nCommand.run(contextFor(appRoot, ['check']));

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.summary).toBe(msg('cli.i18n.ok', { locales: 2, keys: 2 }));
    expect(result.lines?.some((line) => line.includes('extra'))).toBe(true);
    // The column that says the catalogs reached the RUNNING app, not just the disk.
    expect(result.lines?.some((line) => line.includes('registered'))).toBe(true);
  });

  test('a complete catalog that no module registered fails, where both guards were green', async () => {
    const appRoot = await seedApp();
    await Bun.write(
      join(appRoot, 'packages/i18n/catalogs/es.json'),
      `${JSON.stringify({ greeting: 'Hola', farewell: 'Adios' }, null, 2)}\n`,
    );
    // Deliberately no `registerSeededCatalogs`: this IS the app issue #249 reported — every key
    // on disk, every key used in source, and `defineCatalogs()` in a module nothing imports.
    const result = await i18nCommand.run(contextFor(appRoot, ['check']));

    expect(result.ok).toBe(false);
    const codes = (result.findings ?? []).map((finding) => finding.code);
    expect(codes).toContain('X_CATALOG_UNREGISTERED');
    const finding = (result.findings ?? []).find(
      (candidate) => candidate.code === 'X_CATALOG_UNREGISTERED',
    );
    expect(finding?.at).toBe('packages/i18n/catalogs/en.json');
    expect(finding?.cause).toContain('greeting');
    // `en` IS named by the index this fixture writes, so the cause is the package's own — a call
    // in a module nothing imports — and the fix stays the package's own "move the call" line.
    expect(finding?.fix).toContain('defineCatalogs');
    // en (5 keys) + es (2 keys), across two locales — every one a `⟦key⟧` on a rendered page.
    expect(result.summary).toBe(msg('cli.i18n.gaps', { missing: 7, locales: 2 }));
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
      // `syncI18nIndex` runs unconditionally on a sync, so a catalog that reached disk some other
      // way — a hand-created file, a merge — is registered by the command its own `fix:` names.
      registered: true,
      // A real merge copies real strings, so nothing here is waiting on a human.
      placeholders: [],
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

  // `X_CATALOG_MISSING_KEYS` says `x i18n sync <locale>`, `i18n` is a step of the gate, and for the
  // DEFAULT locale that command merged the catalog into itself: `added` was empty by construction.
  // Measured before the fix, on this fixture: `ok: true`, "0 key(s) added", the file byte-identical
  // and `check` still red — the only escape left was a hand edit nothing named.
  test('the default locale syncs from SOURCE, seeding every key it does not define', async () => {
    const appRoot = await seedApp();
    await Bun.write(join(appRoot, 'app/extra.ts'), "t('app.new.title'); t('app.new.cta');\n");
    const before = await readCatalog(join(appRoot, 'packages/i18n/catalogs/en.json'));
    expect(before['app.new.title']).toBeUndefined();

    const result = await i18nCommand.run(contextFor(appRoot, ['sync', 'en']));

    const data = result.data as { added: readonly string[]; placeholders: readonly string[] };
    expect(data.added).toEqual(['app.new.cta', 'app.new.title']);
    // Named separately from `added`, because `--json` has to tell a copied translation from a
    // placeholder waiting on a human and the two arrive through the same field.
    expect(data.placeholders).toEqual(['app.new.cta', 'app.new.title']);
  });

  test('a seeded key is the loud miss the framework already renders, and lands where it is edited', async () => {
    const appRoot = await seedApp();
    await Bun.write(join(appRoot, 'app/extra.ts'), "t('app.new.title');\n");
    await i18nCommand.run(contextFor(appRoot, ['sync', 'en']));

    const after = await readCatalog(join(appRoot, 'packages/i18n/catalogs/en.json'));
    expect(after['app.new.title']).toBe('⟦app.new.title⟧');
    // Every key that already had a translation keeps it — seeding is never a rewrite.
    expect(after['greeting']).toBe('Hello');
    expect(after['nav.about']).toBe('About');
    // Written NESTED, like every other catalog this command writes: a flat dot-key file is one
    // `loadCatalog` refuses on the very next read, so `readCatalog` above is the whole assertion.
    const raw: unknown = await Bun.file(join(appRoot, 'packages/i18n/catalogs/en.json')).json();
    expect(raw).toMatchObject({ app: { new: { title: '⟦app.new.title⟧' } } });
  });

  // The half that keeps the seeding honest. Following the fix moves the author from "stuck" to
  // "one obvious edit per key" — it does NOT make the app shippable, and the gate must not say it
  // does. `auditCatalogs` asks `Object.hasOwn` and nothing else, so before
  // `withPlaceholdersMissing` this exact sequence answered `[]` and turned the `i18n` gate step
  // green over strings no human had read: issue #249's ending, reached by running the command the
  // error recommends.
  test('a seeded placeholder is still a missing key — sync does not certify the app', async () => {
    const appRoot = await seedApp();
    await Bun.write(join(appRoot, 'app/extra.ts'), "t('app.new.title');\n");
    await i18nCommand.run(contextFor(appRoot, ['sync', 'en']));
    await registerSeededCatalogs(appRoot);

    const result = await i18nCommand.run(contextFor(appRoot, ['check']));
    // `es` is red too and for the ordinary reason — it was never synced. The claim here is about
    // `en`, the locale `sync` just wrote, whose only remaining gap is the placeholder it wrote.
    const seeded = (result.findings ?? []).find(
      (f) => f.code === 'X_CATALOG_MISSING_KEYS' && f.at === 'packages/i18n/catalogs/en.json',
    );
    expect(seeded?.cause).toContain('app.new.title');
    expect(result.ok).toBe(false);
  });

  // And the edit the placeholder is asking for is what clears it — the instruction terminates.
  test('replacing the placeholder with a real string clears the finding', async () => {
    const appRoot = await seedApp();
    await Bun.write(join(appRoot, 'app/extra.ts'), "t('app.new.title');\n");
    await i18nCommand.run(contextFor(appRoot, ['sync', 'en']));

    const path = join(appRoot, 'packages/i18n/catalogs/en.json');
    const raw = await Bun.file(path).text();
    await Bun.write(path, raw.replace('⟦app.new.title⟧', 'New'));
    await i18nCommand.run(contextFor(appRoot, ['sync', 'es']));
    await registerSeededCatalogs(appRoot);

    const result = await i18nCommand.run(contextFor(appRoot, ['check']));
    const missing = result.findings?.filter((f) => f.code === 'X_CATALOG_MISSING_KEYS') ?? [];
    expect(missing).toEqual([]);
  });

  // A placeholder propagates: `sync es` copies `en`'s values verbatim, marker included, so a key
  // nobody has translated is red in every locale rather than red in one and silently wrong in the
  // rest. The `en` finding above is the one an author acts on.
  test('a placeholder copied into another locale is missing there too', async () => {
    const appRoot = await seedApp();
    await Bun.write(join(appRoot, 'app/extra.ts'), "t('app.new.title');\n");
    await i18nCommand.run(contextFor(appRoot, ['sync', 'en']));
    await i18nCommand.run(contextFor(appRoot, ['sync', 'es']));
    await registerSeededCatalogs(appRoot);

    const result = await i18nCommand.run(contextFor(appRoot, ['check']));
    const missing = result.findings?.filter((f) => f.code === 'X_CATALOG_MISSING_KEYS') ?? [];
    expect(missing.map((f) => f.at)).toEqual([
      'packages/i18n/catalogs/en.json',
      'packages/i18n/catalogs/es.json',
    ]);
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
      // The second half of adding a locale: the index names it, so `x verify --only i18n` is
      // green immediately instead of red with a fix naming an edit already made (#F4).
      registered: true,
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

  // Same code as a bad flag, so the cause is what separates them: `--locale on "x i18n"` is what
  // a MALFORMED locale reports (the test below), and it is exactly wrong for one that is absent —
  // there is no `--locale` flag to supply.
  test('a locale with no positional is refused before touching disk, naming the positional', async () => {
    const appRoot = await seedApp();
    const thrown = await rejectedBy(() => i18nCommand.run(contextFor(appRoot, ['add'])));
    expect(thrown).toBeUltimateError('X_CLI_BAD_FLAG');
    expect(thrown.cause).toBe('"x i18n add" needs a <locale> positional and got none');
    expect(thrown.fix).toBe('x i18n add es');
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
