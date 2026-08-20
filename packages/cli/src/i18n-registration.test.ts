// The question issue #249 shipped through. A catalog file on disk, keys used in source, and an
// audit of one against the other are all green while the running app renders `⟦key⟧` for every
// one — because registration is a side effect of importing a module, and nothing imported it.
// The loader is injected so a fixture can be exactly "the app loaded and registered nothing".

import { afterEach, describe, expect, test } from 'bun:test';
import type { Catalog, Extraction, Locale } from '@ultimat3/i18n';
import { flattenCatalog, registerCatalog, resetCatalogs, resetLocaleConfig } from '@ultimat3/i18n';
import { VERIFY_STEPS } from './cmd-verify';
import { checkRegistration } from './i18n-registration';

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
