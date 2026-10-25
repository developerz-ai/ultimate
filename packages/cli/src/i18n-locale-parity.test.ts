// The two rules a locale's catalog must satisfy against the reference locale's — the same
// interpolation slots, and no untranslated copy — and the two callers that report them: `x verify`'s
// `i18n` step (through the `catalogFindings` composition) and `x i18n check`. One implementation, so
// the gate and the command can never disagree about an app.
//
// The command is imported directly rather than dispatched through `registry.ts`, so a failure here
// names this command and not the router — `ParsedArgs` still comes from the real `parseArgs`.

import { afterEach, describe, expect, test } from 'bun:test';
// why: `node:` and not Bun: Bun has no API for a temporary directory (`mkdtempSync` + `tmpdir`) and
// none for a recursive delete (`rmSync`). `node:path` comes with them — `Bun.write` takes the
// joined path, but only `node:path` can build one.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { DEFAULT_LOCALE } from '@ultimat3/core';
import type { Catalog } from '@ultimat3/i18n';
import { REQUIRED_BUN } from './app-root';
import { i18nCommand } from './cmd-i18n';
import type { CommandContext } from './command';
import { localeParityFindings } from './i18n-locale-parity';
import { catalogFindings } from './i18n-registration';
import { msg } from './messages';
import { parseArgs } from './parse';

let root = '';

/** The two catalogs a fixture compares: `en` is the reference, `es` the locale under test. */
const pair = (en: Catalog, es: Catalog): Readonly<Record<string, Catalog>> => ({ en, es });

/**
 * A real app root with two catalogs on disk: `en` is the reference, `es` the locale under test.
 * The module `packages/i18n/src/index.ts` imports `@ultimat3/i18n`, which a temp directory cannot
 * resolve — the load finding that follows is this fixture's business, and the parity findings are
 * read out of the same list beside it.
 */
async function seedApp(en: unknown, es: unknown): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'x-i18n-parity-'));
  await Bun.write(join(root, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  await Bun.write(join(root, 'app/page.ts'), "t('app.post.greeting');\n");
  await Bun.write(join(root, 'packages/i18n/catalogs/en.json'), `${JSON.stringify(en, null, 2)}\n`);
  await Bun.write(join(root, 'packages/i18n/catalogs/es.json'), `${JSON.stringify(es, null, 2)}\n`);
  await Bun.write(
    join(root, 'packages/i18n/src/index.ts'),
    [
      "import { defineCatalogs } from '@ultimat3/i18n';",
      "import en from '../catalogs/en.json';",
      "import es from '../catalogs/es.json';",
      "export const catalogs = defineCatalogs({ default: 'en', locales: { en, es } });",
      '',
    ].join('\n'),
  );
  return root;
}

function contextFor(appRoot: string): CommandContext {
  return {
    args: parseArgs(['i18n', 'check'], [i18nCommand.spec]),
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
});

describe('unit · the slots of two locales must be the same set', () => {
  test('the same slots in another order are the same string — interpolate substitutes by name', () => {
    const findings = localeParityFindings(
      pair(
        { 'app.post.greeting': 'Hello {name}, welcome to {place}' },
        { 'app.post.greeting': 'Bienvenido a {place}, {name}' },
      ),
    );

    expect(findings).toEqual([]);
  });

  test('a slot the locale has and the reference does not is a finding', () => {
    const findings = localeParityFindings(
      pair({ 'app.post.greeting': 'Hello' }, { 'app.post.greeting': 'Hola {name}' }),
    );

    expect(findings.map((finding) => finding.code)).toEqual(['X_CATALOG_SLOT_MISMATCH']);
    const [finding] = findings;
    expect(finding?.at).toBe('packages/i18n/catalogs/es.json');
    // The locale, the key and the file: a reader must not have to diff two catalogs to learn
    // which one is wrong.
    expect(finding?.cause).toContain('packages/i18n/catalogs/es.json');
    expect(finding?.cause).toContain('app.post.greeting');
    expect(finding?.cause).toContain('{name}');
    expect(finding?.fix).toContain('packages/i18n/catalogs/es.json');
    // The fix names the EDIT, not only the file: with no slot in the reference, the repair is to
    // remove the locale's slot — renaming it would point at a name the reference never had.
    expect(finding?.fix).toContain('remove {name} from');
  });

  test('a slot the reference has and the locale does not is a finding', () => {
    const findings = localeParityFindings(
      pair({ 'app.post.greeting': 'Hello {name}' }, { 'app.post.greeting': 'Hola' }),
    );

    expect(findings.map((finding) => finding.code)).toEqual(['X_CATALOG_SLOT_MISMATCH']);
    const [finding] = findings;
    expect(finding?.at).toBe('packages/i18n/catalogs/es.json');
    expect(finding?.cause).toContain('{name}');
    expect(finding?.cause).toContain('es');
  });

  // A renamed slot is BOTH directions at once, and the two repairs differ — one is a rename, the
  // other an addition — so the rule reports both rather than one cause that names half of it.
  test('a renamed slot is a finding in each direction', () => {
    const findings = localeParityFindings(
      pair({ 'app.post.greeting': 'Hello {name}' }, { 'app.post.greeting': 'Hola {nombre}' }),
    );

    expect(findings.map((finding) => finding.code)).toEqual([
      'X_CATALOG_SLOT_MISMATCH',
      'X_CATALOG_SLOT_MISMATCH',
    ]);
    expect(findings[0]?.cause).toContain('{nombre}');
    expect(findings[1]?.cause).toContain('{name}');
  });

  test('a key only one catalog defines is a missing key, not a parity finding', () => {
    const findings = localeParityFindings(
      pair(
        { 'app.post.greeting': 'Hello', 'app.post.farewell': 'Bye' },
        { 'app.post.greeting': 'Hola' },
      ),
    );

    expect(findings).toEqual([]);
  });

  test('an app that ships no reference catalog is not compared', () => {
    const findings = localeParityFindings({ es: { 'app.post.greeting': 'Hola {name}' } });

    expect(findings).toEqual([]);
  });

  // A placeholder is a loud miss, not a translation: `x i18n sync` seeds one into every key
  // nobody has translated, so a slot comparison across it blames the marker and prints a fix
  // that edits it. The hole is `X_CATALOG_MISSING_KEYS`'s finding — a missing key, not a
  // mismatch — so the parity rule stays quiet over it.
  test('a placeholder in the locale is a missing key, not a slot mismatch', () => {
    const findings = localeParityFindings(
      pair({ 'app.post.greeting': 'Hello {name}' }, { 'app.post.greeting': '⟦app.post.greeting⟧' }),
    );

    expect(findings).toEqual([]);
  });

  test('a placeholder in the reference does not blame the translation', () => {
    const findings = localeParityFindings(
      pair({ 'app.post.greeting': '⟦app.post.greeting⟧' }, { 'app.post.greeting': 'Hola {name}' }),
    );

    expect(findings).toEqual([]);
  });
});

describe('unit · an identical string is a copy only above the bar', () => {
  // Exactly 24 characters, and 25 with one more — the boundary the rule draws.
  const twentyFour = 'Welcome to our community';
  const twentyFive = 'Welcome to our community!';

  test('an identical value of exactly 24 characters is legitimate', () => {
    expect(twentyFour).toHaveLength(24);

    const findings = localeParityFindings(
      pair({ 'app.post.title': twentyFour }, { 'app.post.title': twentyFour }),
    );

    expect(findings).toEqual([]);
  });

  test('an identical value of 25 characters is an untranslated copy', () => {
    expect(twentyFive).toHaveLength(25);

    const findings = localeParityFindings(
      pair({ 'app.post.title': twentyFive }, { 'app.post.title': twentyFive }),
    );

    expect(findings.map((finding) => finding.code)).toEqual(['X_CATALOG_UNTRANSLATED']);
    const [finding] = findings;
    expect(finding?.at).toBe('packages/i18n/catalogs/es.json');
    expect(finding?.cause).toContain('app.post.title');
    expect(finding?.cause).toContain('packages/i18n/catalogs/es.json');
    expect(finding?.cause).toContain('es');
  });

  test('a placeholder is a missing key, not an untranslated copy', () => {
    const marker = '⟦Welcome to our community!⟧';

    const findings = localeParityFindings(
      pair({ 'app.post.title': marker }, { 'app.post.title': marker }),
    );

    expect(findings).toEqual([]);
  });

  // A cause is one line: the whole sentence quoted would wrap it.
  test('a long value is quoted capped', () => {
    const long = 'Welcome to our community, where every good conversation begins today';
    expect(long.length).toBeGreaterThan(60);

    const findings = localeParityFindings(
      pair({ 'app.post.title': long }, { 'app.post.title': long }),
    );

    expect(findings.map((finding) => finding.code)).toEqual(['X_CATALOG_UNTRANSLATED']);
    const [finding] = findings;
    expect(finding?.cause).toContain(`${long.slice(0, 60)}…`);
    expect(finding?.cause).not.toContain(long);
  });
});

describe('unit · the gate and the command report the same parity findings', () => {
  // The catalogs that make `es` drift from `en`: the reference interpolates `{name}`, the locale
  // does not, so the value it carries never renders there.
  const en = { app: { post: { greeting: 'Hello {name}' } } };
  const es = { app: { post: { greeting: 'Hola' } } };

  test('`catalogFindings` — what `x verify --only i18n` reports — carries them', async () => {
    const appRoot = await seedApp(en, es);

    const findings = await catalogFindings(appRoot);

    const parity = findings.filter((finding) => finding.code === 'X_CATALOG_SLOT_MISMATCH');
    expect(parity).toHaveLength(1);
    expect(parity[0]?.at).toBe('packages/i18n/catalogs/es.json');
    expect(parity[0]?.cause).toContain('app.post.greeting');
  });

  test('`x i18n check` reports the same finding, fails, and names it in the summary', async () => {
    const appRoot = await seedApp(en, es);

    const result = await i18nCommand.run(contextFor(appRoot));

    expect(result.ok).toBe(false);
    const parity = (result.findings ?? []).filter(
      (finding) => finding.code === 'X_CATALOG_SLOT_MISMATCH',
    );
    expect(parity).toHaveLength(1);
    expect(parity[0]?.at).toBe('packages/i18n/catalogs/es.json');
    // The summary names the parity findings: `cli.i18n.gaps` counts MISSING KEYS, so it answered
    // "0 missing key(s) across 0 locale(s)" over a locale whose slots had drifted.
    expect(result.summary).toBe(
      msg('cli.i18n.parity', { count: 1, locales: 1, reference: DEFAULT_LOCALE }),
    );
    expect(result.summary).not.toContain('0 missing key(s)');
  });

  test('a catalog that agrees with the reference is not a finding', async () => {
    const appRoot = await seedApp(
      { app: { post: { greeting: 'Hello {name}' } } },
      { app: { post: { greeting: 'Hola {name}' } } },
    );

    const result = await i18nCommand.run(contextFor(appRoot));

    expect((result.findings ?? []).map((finding) => finding.code)).not.toContain(
      'X_CATALOG_SLOT_MISMATCH',
    );
    expect((result.findings ?? []).map((finding) => finding.code)).not.toContain(
      'X_CATALOG_UNTRANSLATED',
    );
  });

  // The marker `x i18n sync` writes for a key nobody has translated: the gate reports it as the
  // missing key it is, and the parity rule stays quiet over it.
  test('a placeholder is a missing key, not a slot mismatch', async () => {
    const appRoot = await seedApp(
      { app: { post: { greeting: 'Hello {name}' } } },
      { app: { post: { greeting: '⟦app.post.greeting⟧' } } },
    );

    const findings = await catalogFindings(appRoot);

    expect(findings.map((finding) => finding.code)).toContain('X_CATALOG_MISSING_KEYS');
    expect(findings.map((finding) => finding.code)).not.toContain('X_CATALOG_SLOT_MISMATCH');
  });
});
