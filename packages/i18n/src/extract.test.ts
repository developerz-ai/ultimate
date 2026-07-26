import { describe, expect, test } from 'bun:test';
import { flattenCatalog } from './catalog';
import { assertCatalogsComplete, auditCatalogs, extractKeys } from './extract';

const source = `import { t } from '@ultimat3/i18n';

export function Row(props: { count: number }) {
  const label = t('pagination.result', { count: props.count });
  const title = t("errors.notFound.title");
  const dynamic = t(props.key);
  if (t.has('admin.nav.jobs')) return label;
  return format(title) + translate('common.save');
}
`;

describe('extractKeys', () => {
  test('finds static keys with positions and flags dynamic ones', () => {
    const extraction = extractKeys(source, 'row.tsx');
    expect(extraction.usages.map((usage) => usage.key)).toEqual([
      'pagination.result',
      'errors.notFound.title',
      'admin.nav.jobs',
      'common.save',
    ]);
    expect(extraction.usages[0]?.line).toBe(4);
    expect(extraction.usages[0]?.file).toBe('row.tsx');
    expect(extraction.dynamic).toHaveLength(1);
    expect(extraction.dynamic[0]?.expression).toBe('props.key');
    expect(extraction.dynamic[0]?.line).toBe(6);
  });

  test('does not match a method call or an unrelated function', () => {
    const extraction = extractKeys(`ctx.t('skip.me'); format('nope'); shortest('no')`);
    expect(extraction.usages).toHaveLength(0);
  });
});

describe('auditCatalogs', () => {
  const extraction = extractKeys(source, 'row.tsx');
  const en = flattenCatalog({
    pagination: { result: '{count} result', result_plural: '{count} results' },
    errors: { notFound: { title: 'Page not found' } },
    admin: { nav: { jobs: 'Jobs' } },
    common: { save: 'Save', unusedKey: 'Never rendered' },
  });
  const es = flattenCatalog({
    pagination: { result: '{count} resultado', result_plural: '{count} resultados' },
    errors: { notFound: { title: 'Página no encontrada' } },
  });

  test('a plural-only definition counts as present', () => {
    const report = auditCatalogs({ extraction, catalogs: { en } });
    expect(report.locales[0]?.missing).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('reports keys missing per locale and keys defined but unused', () => {
    const report = auditCatalogs({ extraction, catalogs: { en, es } });
    const spanish = report.locales.find((audit) => audit.locale === 'es');
    expect(spanish?.missing).toEqual(['admin.nav.jobs', 'common.save']);
    const english = report.locales.find((audit) => audit.locale === 'en');
    expect(english?.unused).toEqual(['common.unusedKey']);
    expect(report.ok).toBe(false);
  });

  test('ignoreUnused suppresses runtime-resolved namespaces', () => {
    const report = auditCatalogs({
      extraction,
      catalogs: { en },
      ignoreUnused: ['common.*'],
    });
    expect(report.locales[0]?.unused).toEqual([]);
  });

  test('x verify gate throws X_CATALOG_MISSING_KEYS naming the locale', () => {
    const report = auditCatalogs({ extraction, catalogs: { en, es } });
    let code = 'no-throw';
    let cause = '';
    try {
      assertCatalogsComplete(report);
    } catch (error) {
      code = String((error as { code?: unknown }).code);
      cause = String((error as { cause?: unknown }).cause);
    }
    expect(code).toBe('X_CATALOG_MISSING_KEYS');
    expect(cause).toContain('es.json');
    expect(cause).toContain('admin.nav.jobs');
  });
});
