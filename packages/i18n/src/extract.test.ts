import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// Bun ships no temp-directory primitive; `mkdtemp` is what gives this file a root of its own,
// so nothing here depends on another test having run or on a fixed path being free.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flattenCatalog } from './catalog';
import {
  assertCatalogsComplete,
  auditCatalogs,
  extractFromFiles,
  extractKeys,
  mergeExtractions,
} from './extract';

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

describe('mergeExtractions', () => {
  test('concatenates both halves in argument order and keeps them apart', () => {
    const first = extractKeys("t('a.one'); t(props.x)", 'a.tsx');
    const second = extractKeys("t('b.one'); t('b.two')", 'b.tsx');
    const merged = mergeExtractions(first, second);
    expect(merged.usages.map((usage) => `${usage.file}:${usage.key}`)).toEqual([
      'a.tsx:a.one',
      'b.tsx:b.one',
      'b.tsx:b.two',
    ]);
    // The dynamic list is a separate report, not folded into `usages` — a `t(variable)` the
    // extractor cannot verify must never read as a verified key.
    expect(merged.dynamic.map((entry) => entry.expression)).toEqual(['props.x']);
    expect(merged.usages.some((usage) => usage.key === 'props.x')).toBe(false);
  });

  test('merging nothing is an empty extraction, not undefined halves', () => {
    expect(mergeExtractions()).toEqual({ usages: [], dynamic: [] });
    // And a merge is a copy: mutating the result must not reach back into an input.
    const one = extractKeys("t('a.one')", 'a.tsx');
    const merged = mergeExtractions(one);
    merged.usages.length = 0;
    expect(one.usages).toHaveLength(1);
  });
});

describe('extractFromFiles', () => {
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ultimate-i18n-extract-'));
    await Bun.write(join(root, 'a.tsx'), "const x = t('nav.home');\nconst y = t(props.key);\n");
    await Bun.write(join(root, 'b.tsx'), "const z = translate('common.save');\n");
    await Bun.write(join(root, 'c.tsx'), "const w = tr('custom.callee');\n");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('reads each path and labels every usage with the path it came from', async () => {
    const extraction = await extractFromFiles([join(root, 'a.tsx'), join(root, 'b.tsx')]);
    expect(extraction.usages.map((usage) => usage.key)).toEqual(['nav.home', 'common.save']);
    expect(extraction.usages[0]?.file).toBe(join(root, 'a.tsx'));
    expect(extraction.usages[1]?.file).toBe(join(root, 'b.tsx'));
    expect(extraction.usages[0]?.line).toBe(1);
    expect(extraction.dynamic).toEqual([
      { expression: 'props.key', file: join(root, 'a.tsx'), line: 2, column: 11 },
    ]);
  });

  test('results follow the order of the paths, not whatever the reads finished in', async () => {
    const reversed = await extractFromFiles([join(root, 'b.tsx'), join(root, 'a.tsx')]);
    expect(reversed.usages.map((usage) => usage.key)).toEqual(['common.save', 'nav.home']);
  });

  test('forwards the options to every file, not only the first', async () => {
    const extraction = await extractFromFiles([join(root, 'a.tsx'), join(root, 'c.tsx')], {
      callees: ['tr'],
    });
    // `callees: ['tr']` REPLACES the defaults, so `t(...)` in a.tsx is no longer a call.
    expect(extraction.usages.map((usage) => usage.key)).toEqual(['custom.callee']);
  });

  test('an unreadable path fails the extraction instead of being skipped silently', async () => {
    // A glob that outran a deleted file must not shrink the audit to "no missing keys".
    await expect(extractFromFiles([join(root, 'does-not-exist.tsx')])).rejects.toThrow(
      /does-not-exist/,
    );
  });
});
