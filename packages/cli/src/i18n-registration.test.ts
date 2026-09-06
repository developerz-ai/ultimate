// The question issue #249 shipped through. A catalog file on disk, keys used in source, and an
// audit of one against the other are all green while the running app renders `⟦key⟧` for every
// one — because registration is a side effect of importing a module, and nothing imported it.
// The loader is injected so a fixture can be exactly "the app loaded and registered nothing".

import { afterEach, describe, expect, test } from 'bun:test';
import type { Catalog, Extraction, ExtractReport, Locale } from '@ultimat3/i18n';
import {
  auditCatalogs,
  flattenCatalog,
  registerCatalog,
  resetCatalogs,
  resetLocaleConfig,
} from '@ultimat3/i18n';
import { VERIFY_STEPS } from './cmd-verify';
import { CLI_ORIGIN, type DuplicateInstall } from './duplicate-packages';
import {
  checkRegistration,
  isLoudMiss,
  loudMiss,
  missingKeyFindings,
  withPlaceholdersMissing,
} from './i18n-registration';

const shipped: Readonly<Record<Locale, Catalog>> = {
  en: flattenCatalog({ app: { play: { title: 'Play' } }, site: { home: { title: 'Home' } } }),
  es: flattenCatalog({ app: { play: { title: 'Jugar' } }, site: { home: { title: 'Inicio' } } }),
};

const usage = (key: string): Extraction['usages'][number] => ({
  key,
  file: 'apps/web/app/play/page.tsx',
  line: 1,
  column: 1,
});

const extraction: Extraction = {
  usages: [usage('app.play.title'), usage('site.home.title')],
  dynamic: [],
};

/** `applies` never runs a command; a runner that would fail loudly if one did. */
const unusedRunner = () => expect.unreachable('applies must not spawn a process');

/** An app that loads and registers nothing — the shape castlefight.online shipped. */
const loadsNothing = async () => ({ findings: [], defaultLocale: 'en' });

/** No second copy anywhere — what every install but one has answered. */
const oneCopy = async () => [];

/** ai-maxxing, 2026-09-05: the root and the CLI on 19.1.0, `packages/i18n` still on 19.0.0. */
const twoCopies: DuplicateInstall = {
  pkg: '@ultimat3/i18n',
  copies: [
    { dir: '/app/node_modules/@ultimat3/i18n', version: '19.1.0', from: ['.', CLI_ORIGIN] },
    {
      dir: '/app/packages/i18n/node_modules/@ultimat3/i18n',
      version: '19.0.0',
      from: ['packages/i18n'],
    },
  ],
};
const duplicated = async () => [twoCopies];

afterEach(() => {
  resetCatalogs();
  resetLocaleConfig();
});

describe('unit · checkRegistration', () => {
  test('a catalog on disk that no module registered is X_CATALOG_UNREGISTERED', async () => {
    const report = await checkRegistration({
      root: '/nowhere',
      catalogs: shipped,
      extraction,
      ignoreUnused: [],
      load: loadsNothing,
      duplicates: oneCopy,
    });

    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toEqual([
      'X_CATALOG_UNREGISTERED',
      'X_CATALOG_UNREGISTERED',
    ]);
    expect(report.findings[0]?.at).toBe('packages/i18n/catalogs/en.json');
    expect(report.findings[0]?.cause).toContain('app.play.title');
    expect(report.findings[0]?.fix).toContain('defineCatalogs');
    // Both locales, every key: this is what a page would have rendered as a loud miss.
    expect(report.unregistered).toBe(4);
    expect(report.locales).toBe(2);
    expect(report.unregisteredLocales).toEqual(['en', 'es']);
  });

  test('the same gap over TWO installed copies is the install, not the defineCatalogs() call', async () => {
    const report = await checkRegistration({
      root: '/app',
      catalogs: shipped,
      extraction,
      ignoreUnused: [],
      load: loadsNothing,
      duplicates: duplicated,
    });

    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toEqual([
      'X_PACKAGE_DUPLICATED',
      'X_CATALOG_UNREGISTERED',
      'X_CATALOG_UNREGISTERED',
    ]);
    const [install, gap] = report.findings;
    expect(install?.at).toBe('package.json');
    expect(install?.cause).toContain(
      'node_modules/@ultimat3/i18n@19.1.0 (resolved from ., the x CLI) and packages/i18n/node_modules/@ultimat3/i18n@19.0.0 (resolved from packages/i18n)',
    );
    // The registry's own fix — move `defineCatalogs()` — names an edit to a file that is already
    // right. The gap says what the install did to it, and carries the install's fix instead.
    expect(gap?.cause).toContain('2 copies of @ultimat3/i18n are installed');
    expect(gap?.cause).toContain("2 of packages/i18n/catalogs/en.json's 2 key(s)");
    expect(gap?.fix).toBe(
      'set "@ultimat3/i18n": "19.1.0" in packages/i18n/package.json, then: bun install && x i18n check --json',
    );
    expect(gap?.fix).not.toContain('defineCatalogs');
    expect(gap?.at).toBe('packages/i18n/catalogs/en.json');
    // The counts are the gap's own: a duplicate is one more finding, not one more locale.
    expect(report.unregistered).toBe(4);
    expect(report.locales).toBe(2);
  });

  test('two copies with every catalog registered is still a finding: another workspace reads the other', async () => {
    const report = await checkRegistration({
      root: '/app',
      catalogs: shipped,
      extraction,
      ignoreUnused: [],
      load: async () => {
        for (const [locale, catalog] of Object.entries(shipped)) registerCatalog(locale, catalog);
        return { findings: [], defaultLocale: 'en' };
      },
      duplicates: duplicated,
    });

    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toEqual(['X_PACKAGE_DUPLICATED']);
    expect(report.unregistered).toBe(0);
    expect(report.registered).toEqual(['en', 'es']);
  });

  test('the same app, correctly wired, is not a finding', async () => {
    const report = await checkRegistration({
      root: '/nowhere',
      catalogs: shipped,
      extraction,
      ignoreUnused: [],
      load: async () => {
        for (const [locale, catalog] of Object.entries(shipped)) registerCatalog(locale, catalog);
        return { findings: [], defaultLocale: 'en' };
      },
    });

    expect(report).toEqual({
      ok: true,
      findings: [],
      unregistered: 0,
      locales: 0,
      unregisteredLocales: [],
      registered: ['en', 'es'],
    });
  });

  test('no catalog anywhere plus keys in source is the vacuous green, refused', async () => {
    const report = await checkRegistration({
      root: '/nowhere',
      catalogs: {},
      extraction,
      ignoreUnused: [],
      load: loadsNothing,
    });

    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.code).toBe('X_CATALOG_UNREGISTERED');
    expect(report.findings[0]?.cause).toContain('app.play.title');
    // The locale the app declared, not a guess: `x i18n add <locale>` is the fix line.
    expect(report.findings[0]?.fix).toContain('x i18n add en');
    expect(report.unregistered).toBe(2);
  });

  test('no catalog anywhere and no key used is silence, not a finding', async () => {
    const report = await checkRegistration({
      root: '/nowhere',
      catalogs: {},
      extraction: { usages: [], dynamic: [] },
      ignoreUnused: [],
      load: loadsNothing,
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  test('a framework key needs no app catalog — the base layer answers it', async () => {
    const report = await checkRegistration({
      root: '/nowhere',
      catalogs: {},
      extraction: { usages: [usage('errors.notFound.title')], dynamic: [] },
      ignoreUnused: [],
      load: loadsNothing,
    });

    expect(report.ok).toBe(true);
  });

  test('a module that would not import rides along — that is how catalogs go missing', async () => {
    const broken = {
      code: 'X_CLI_UNEXPECTED',
      cause: 'packages/i18n/src/index.ts: SyntaxError',
      fix: 'x doctor --json',
      at: 'packages/i18n/src/index.ts',
    };

    const report = await checkRegistration({
      root: '/nowhere',
      catalogs: shipped,
      extraction,
      ignoreUnused: [],
      load: async () => ({ findings: [broken], defaultLocale: 'en' }),
    });

    expect(report.findings).toContainEqual(broken);
  });

  test('a broken module is NOT reported when every catalog registered — that is noise on a pass', async () => {
    const report = await checkRegistration({
      root: '/nowhere',
      catalogs: shipped,
      extraction,
      ignoreUnused: [],
      load: async () => {
        for (const [locale, catalog] of Object.entries(shipped)) registerCatalog(locale, catalog);
        return {
          findings: [{ code: 'X_CLI_UNEXPECTED', cause: 'a route', fix: 'x doctor --json' }],
          defaultLocale: 'en',
        };
      },
    });

    expect(report.findings).toEqual([]);
  });
});

describe('unit · the gate asks the same question the command does', () => {
  test('`i18n` is a step of x verify, between the app-load steps and manifest', () => {
    const names = VERIFY_STEPS.map((step) => step.name);

    expect(names).toContain('i18n');
    // Ordering is the contract, not a detail: `budgets` performs the app load, `seo` and `i18n`
    // read the registries it filled, and `manifest` closes the app-load cluster.
    expect(names.slice(names.indexOf('budgets'), names.indexOf('manifest') + 1)).toEqual([
      'budgets',
      'seo',
      'i18n',
      // `policy` reads the same registries `budgets` filled — role grants and route guards — so it
      // joined the cluster rather than paying for a second app load.
      'policy',
      'manifest',
    ]);
  });

  test('it is SKIPPED, never passed, in a repo that is not an app', async () => {
    const step = VERIFY_STEPS.find((candidate) => candidate.name === 'i18n');

    // `/nowhere` has no app.config.ts. A step that answered `ok` there would be claiming a
    // completeness it never had — the same vacuous green this whole slice exists to refuse.
    expect(await step?.applies?.({ root: '/nowhere', runner: unusedRunner })).toBe(false);
    expect(
      await step?.applies?.({
        root: `${import.meta.dir}/../../../examples/dummy`,
        runner: unusedRunner,
      }),
    ).toBe(true);
  });
});

// `auditCatalogs` asks `Object.hasOwn` and nothing else (`packages/i18n/src/extract.ts`), so a key
// present with ANY value is complete — including `⟦key⟧`, which is exactly what
// `x i18n sync <defaultLocale>` writes for every gap it closes. A gate that goes green there
// certifies untranslated strings as shippable, and the command the error recommends is what gets
// you there in one step.
describe('unit · a placeholder is not a translation', () => {
  const report = (catalogs: Readonly<Record<Locale, Catalog>>): ExtractReport =>
    auditCatalogs({ extraction, catalogs });

  test('a value that IS the loud miss is reported missing, though the key is defined', () => {
    const catalogs = {
      en: flattenCatalog({
        app: { play: { title: loudMiss('app.play.title') } },
        site: { home: { title: 'Home' } },
      }),
    };
    // The premise, asserted rather than assumed: the unaudited report calls this catalog complete.
    expect(report(catalogs).locales[0]?.missing).toEqual([]);

    const corrected = withPlaceholdersMissing(report(catalogs), catalogs);
    expect(corrected.locales[0]?.missing).toEqual(['app.play.title']);
    expect(corrected.ok).toBe(false);
    // And it reaches the gate as the same finding a genuinely absent key would.
    expect(missingKeyFindings(corrected).map((finding) => finding.code)).toEqual([
      'X_CATALOG_MISSING_KEYS',
    ]);
  });

  test('a catalog of real strings is untouched — the correction adds nothing on a pass', () => {
    const corrected = withPlaceholdersMissing(report(shipped), shipped);
    expect(corrected.locales.map((audit) => audit.missing)).toEqual([[], []]);
    expect(corrected.ok).toBe(true);
  });

  // A key never used renders nowhere, so a stale placeholder under it is `unused`, not missing —
  // reporting it would send an author to edit a string no page asks for.
  test('a placeholder under a key source never uses is not a missing key', () => {
    const catalogs = {
      en: flattenCatalog({
        app: { play: { title: 'Play' } },
        site: { home: { title: 'Home' } },
        dead: { key: loudMiss('dead.key') },
      }),
    };
    expect(withPlaceholdersMissing(report(catalogs), catalogs).ok).toBe(true);
  });

  // The plural family: `items` has no entry of its own and `items_other` is what renders, so the
  // marker has to be looked for at every spelling `definesKey` accepts. `some`, not `every` — one
  // untranslated category is a placeholder on exactly the rows that hit it.
  test('a plural variant holding the marker is found, though the stem is undefined', () => {
    const plural: Extraction = { usages: [usage('items')], dynamic: [] };
    const catalogs = {
      en: flattenCatalog({ items_one: '1 item', items_other: loudMiss('items') }),
    };
    const audited = auditCatalogs({ extraction: plural, catalogs });
    expect(audited.locales[0]?.missing).toEqual([]);
    expect(withPlaceholdersMissing(audited, catalogs).locales[0]?.missing).toEqual(['items']);
  });

  // One definition of the marker for the whole CLI: `cmd-i18n.ts` seeds through `loudMiss` and the
  // two checks refuse through `isLoudMiss`, so what sync writes is exactly what the gate reads.
  test('the seeder and the detector agree, and a real string is never a placeholder', () => {
    expect(isLoudMiss(loudMiss('any.key'))).toBe(true);
    expect(isLoudMiss('Play')).toBe(false);
    expect(isLoudMiss(undefined)).toBe(false);
    // Any marker, not just this key's: a renamed key leaves the old one behind.
    expect(isLoudMiss(loudMiss('some.other.key'))).toBe(true);
  });
});
