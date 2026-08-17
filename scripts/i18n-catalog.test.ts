// The rule, against fixtures — never against the real catalog: a test that edits
// `packages/i18n/src/catalogs/en.json` to prove it can fail is a test that races the gate it
// guards. Every case here builds the three inputs by hand.

import { describe, expect, test } from 'bun:test';
import type { Extraction } from '@ultimat3/i18n';
import { loadCatalog } from '@ultimat3/i18n';
import { CATALOG_FILE, type CatalogGap, catalogGapFindingFor, checkCatalog } from './i18n-catalog';
import { keyLiteralsIn, stripComments } from './lib/i18n-scan';

const usage = (key: string, file = 'packages/admin/src/list.tsx', line = 44): Extraction =>
  ({ usages: [{ key, file, line, column: 1 }], dynamic: [] }) satisfies Extraction;

const empty: Extraction = { usages: [], dynamic: [] };

const DOLLAR = '$';

const merge = (...parts: readonly Extraction[]): Extraction => ({
  usages: parts.flatMap((part) => part.usages),
  dynamic: parts.flatMap((part) => part.dynamic),
});

const keys = (gaps: readonly CatalogGap[], kind: CatalogGap['kind']): readonly string[] =>
  gaps.filter((gap) => gap.kind === kind).map((gap) => gap.key);

describe('the framework catalog rule', () => {
  test('a rendered key the catalog does not answer is a gap, named at its call site', () => {
    const gaps = checkCatalog({
      catalog: loadCatalog({ admin: { list: { empty: 'Nothing here yet.' } } }),
      extraction: merge(usage('admin.list.empty'), usage('admin.list.loading', 'a.tsx', 7)),
      literals: ['admin.list.empty', 'admin.list.loading'],
    });

    expect(keys(gaps, 'missing')).toEqual(['admin.list.loading']);
    expect(gaps.find((gap) => gap.kind === 'missing')?.at).toBe('a.tsx:7');
  });

  test('a catalog key no framework source names is a gap in a namespace the framework renders', () => {
    const gaps = checkCatalog({
      catalog: loadCatalog({
        admin: { list: { empty: 'Nothing here yet.' }, nav: { dashboard: 'Dashboard' } },
      }),
      extraction: usage('admin.list.empty'),
      literals: ['admin.list.empty'],
    });

    expect(keys(gaps, 'unused')).toEqual(['admin.nav.dashboard']);
  });

  test('a namespace the framework never reaches is the string API it ships, not a gap', () => {
    // `common.*` and `auth.*` exist for an app to render. Reporting them unused would ask this
    // repo to delete the strings it publishes.
    const gaps = checkCatalog({
      catalog: loadCatalog({
        admin: { list: { empty: 'Nothing here yet.' } },
        common: { save: 'Save', cancel: 'Cancel' },
      }),
      extraction: usage('admin.list.empty'),
      literals: ['admin.list.empty'],
    });

    expect(gaps).toEqual([]);
  });

  test('a key carried as data, never as a t() argument, is reached — not deletable', () => {
    // `titleKey: 'admin.dashboard.title'` is rendered by `t(route.titleKey)`. Nothing static can
    // follow that, so the literal set is what keeps the unused half from eating a live key.
    const gaps = checkCatalog({
      catalog: loadCatalog({
        admin: { list: { empty: 'x' }, dashboard: { title: 'Dashboard' } },
      }),
      extraction: usage('admin.list.empty'),
      literals: ['admin.list.empty', 'admin.dashboard.title'],
    });

    expect(gaps).toEqual([]);
  });

  test('a template-literal call covers its whole family, and only its own prefix', () => {
    const gaps = checkCatalog({
      catalog: loadCatalog({
        admin: {
          list: { empty: 'x' },
          operation: { create: 'created', delete: 'deleted' },
          table: { columns: 'Columns' },
        },
      }),
      extraction: merge(usage('admin.list.empty'), {
        usages: [],
        dynamic: [
          {
            // The SOURCE TEXT of a template literal, which is what the extractor hands back.
            // Spelled with `DOLLAR` because a literal `${` inside a plain string is exactly what
            // `noTemplateCurlyInString` warns about, and here it is the subject, not a mistake.
            expression: `\`admin.operation.${DOLLAR}{entry.operation}\``,
            file: 'packages/admin/src/detail.tsx',
            line: 102,
            column: 24,
          },
        ],
      }),
      literals: ['admin.list.empty'],
    });

    expect(keys(gaps, 'unused')).toEqual(['admin.table.columns']);
  });

  test('a plural family defined without its bare stem still answers the stem', () => {
    const gaps = checkCatalog({
      catalog: loadCatalog({ admin: { list: { rows_one: '{count} row', rows_other: '{count}' } } }),
      extraction: usage('admin.list.rows'),
      literals: ['admin.list.rows'],
    });

    expect(gaps).toEqual([]);
  });

  test('an empty catalog with a rendered key fails — the check cannot pass vacuously', () => {
    const gaps = checkCatalog({
      catalog: loadCatalog({}),
      extraction: usage('admin.list.empty'),
      literals: [],
    });

    expect(keys(gaps, 'missing')).toEqual(['admin.list.empty']);
  });

  test('nothing rendered and nothing defined is green, not an error', () => {
    expect(checkCatalog({ catalog: loadCatalog({}), extraction: empty, literals: [] })).toEqual([]);
  });
});

describe('the findings', () => {
  test('the missing finding carries the nesting path an author has to type', () => {
    const finding = catalogGapFindingFor({
      kind: 'missing',
      key: 'admin.list.loading',
      at: 'packages/admin/src/list.tsx:44',
    });

    expect(finding.code).toBe('X_CATALOG_MISSING_KEYS');
    expect(finding.fix).toContain('"admin" › "list" › "loading"');
    expect(finding.fix).toContain(CATALOG_FILE);
  });

  test('the unreachable finding offers both ways out, and points at the catalog', () => {
    const finding = catalogGapFindingFor({
      kind: 'unused',
      key: 'admin.nav.dashboard',
      at: CATALOG_FILE,
    });

    expect(finding.code).toBe('X_CATALOG_KEY_UNREACHABLE');
    expect(finding.at).toBe(CATALOG_FILE);
    expect(finding.fix).toContain('delete');
    expect(finding.fix).toContain("t('admin.nav.dashboard')");
  });
});

describe('the scan', () => {
  test('a whole-line comment contributes no key, and the line count survives', () => {
    const source = ["const a = t('admin.list.empty');", " * `t('items', { count })` is a doc", ''];
    const stripped = stripComments(source.join('\n'));

    expect(stripped.split('\n').length).toBe(3);
    expect(keyLiteralsIn(stripped)).toEqual(['admin.list.empty']);
  });

  test('a key literal is found however it is quoted, and a bare word is not one', () => {
    expect(keyLiteralsIn(`t('a.b'); t("c.d"); t(\`e.f\`); t('single')`)).toEqual([
      'a.b',
      'c.d',
      'e.f',
    ]);
  });
});
