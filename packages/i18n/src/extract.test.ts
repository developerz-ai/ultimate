import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// Bun ships no temp-directory primitive; `mkdtemp` is what gives this file a root of its own,
// so nothing here depends on another test having run or on a fixed path being free.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flattenCatalog } from './catalog';
import { catalogMissingKeys, familyIncomplete } from './errors';
import { auditCatalogs, extractFromFiles, extractKeys, mergeExtractions } from './extract';

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

  // The phantom key that shipped: a call written INSIDE a comment matched the shape, and
  // `x i18n sync` would have written `"…": "⟦…⟧"` into every catalog for a string nobody renders.
  test('a call inside a comment is not a usage, and a // inside a string is not a comment', () => {
    const commented = [
      "// `t('phantom.line', { count })` explains the call below",
      "/* t('phantom.block') */",
      "const real = t('kept.key');",
      "const url = t('kept.url'); // https://example.test",
    ].join('\n');
    const extraction = extractKeys(commented, 'commented.ts');
    expect(extraction.usages.map((usage) => usage.key)).toEqual(['kept.key', 'kept.url']);
    // Positions are read off the original text: the mask keeps every newline in place.
    expect(extraction.usages[0]?.line).toBe(3);
    expect(extraction.usages[1]?.line).toBe(4);
    expect(extraction.dynamic).toHaveLength(0);
  });

  // The same phantom one level over: a fix line or a docs string quoting a call is text, and read as
  // code it reported a key no component renders — and `"t('a' + b)"` reported a dynamic usage.
  test('a call written inside a string is text, not a usage', () => {
    const source = [
      `const hint = "use t('phantom.double') here";`,
      'const fix = \'call t("phantom.single") instead\';',
      // Concatenated so the `${` is the fixture's own placeholder, not this file's.
      "const tpl = `t('phantom.template') $" + "{t('kept.interpolated')} t(name)`;",
      `const mixed = "t('phantom.left')" + t('kept.after');`,
      "const real = t('kept.code', { hint: \"t('phantom.option')\" });",
      `const shown = "t(" + t('kept.adjacent');`,
    ].join('\n');
    const extraction = extractKeys(source, 'strings.ts');
    expect(extraction.usages.map((usage) => usage.key)).toEqual([
      'kept.interpolated',
      'kept.after',
      'kept.code',
      'kept.adjacent',
    ]);
    expect(extraction.dynamic).toHaveLength(0);
    // The key is still read off the original text, at the call's own position.
    expect(extraction.usages[0]).toMatchObject({ line: 3, column: 38 });
    expect(extraction.usages[3]).toMatchObject({ line: 6, column: 22 });
  });

  // JSX text is not a string, and its apostrophe opens nothing: read as an opener, `Don't` ran to
  // the quote of the `t('` after it, blanked the call and lost a key HEAD found.
  test('an apostrophe in JSX text does not hide the call after it', () => {
    const source = [
      "const a = <p>Don't {t('a.one')}</p>;",
      "const b = <p>It's {t('b.one')} and it's {t(\"b.two\")}</p>;",
    ].join('\n');
    const extraction = extractKeys(source, 'apostrophe.tsx');
    expect(extraction.usages.map((usage) => usage.key)).toEqual(['a.one', 'b.one', 'b.two']);
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

  // The gate reads this report (cli `i18n-registration.ts`) and raises `catalogMissingKeys` from it.
  test('a missing-keys finding is X_CATALOG_MISSING_KEYS naming the locale file and keys', () => {
    const report = auditCatalogs({ extraction, catalogs: { en, es } });
    const gap = report.locales.find((audit) => audit.missing.length > 0);
    if (gap === undefined) expect.unreachable('the es catalog lacks keys source uses');
    const { code, cause } = catalogMissingKeys(gap.locale, gap.missing);
    expect(code).toBe('X_CATALOG_MISSING_KEYS');
    expect(cause).toContain('es.json');
    expect(cause).toContain('admin.nav.jobs');
  });
});

describe('extractKeys \u00B7 declared properties', () => {
  const options = {
    properties: [{ name: 'titleKey' }, { name: 'subject', whenFileContains: 'defineThing(' }],
  };

  test('a literal value of a declared property is a usage, at the position of its name', () => {
    const extraction = extractKeys("const a = {\n  titleKey: 'a.title',\n};\n", 'a.ts', options);
    expect(extraction.usages).toEqual([{ key: 'a.title', file: 'a.ts', line: 2, column: 3 }]);
    expect(extraction.dynamic).toEqual([]);
  });

  test('a property with whenFileContains counts only in a file that holds the marker', () => {
    const declared = "defineThing({ subject: 'a.subject' });";
    expect(extractKeys(declared, 'a.ts', options).usages.map((usage) => usage.key)).toEqual([
      'a.subject',
    ]);
    // The marker alone in a comment is not the declaration, and the marker's absence is not a key.
    const noted = "// defineThing( is elsewhere\nconst row = { subject: 'Plain words' };";
    expect(extractKeys(noted, 'a.ts', options).usages).toEqual([]);
    expect(extractKeys(noted, 'a.ts', options).dynamic).toEqual([]);
  });

  test('an interpolated key, a concatenation and a variable are dynamic, never a usage', () => {
    const lines = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text \u2014 a literal ${\u2026} is the case under test
      'const a = { titleKey: `plans.${plan}.title` };',
      "const b = { titleKey: 'a.' + 'b' };",
      'const c = { titleKey: someVariable };',
    ];
    const extraction = extractKeys(lines.join('\n'), 'a.ts', options);
    expect(extraction.usages).toEqual([]);
    expect(extraction.dynamic.map((entry) => entry.expression)).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the expression is source text
      '`plans.${plan}.title`',
      "'a.' + 'b'",
      'someVariable',
    ]);
  });

  test('a comma inside the literal does not end the value', () => {
    const extraction = extractKeys(
      "const a = { titleKey: 'one, two', other: 1 };",
      'a.ts',
      options,
    );
    expect(extraction.usages.map((usage) => usage.key)).toEqual(['one, two']);
  });

  test('a type member is not a value, and neither is a longer name ending in the property', () => {
    const lines = [
      'interface A { titleKey: string; readonly other: string }',
      "const b = { subtitleKey: 'not.this', 'x.titleKey': 1, c: d.titleKey };",
    ];
    const extraction = extractKeys(lines.join('\n'), 'a.ts', options);
    expect(extraction.usages).toEqual([]);
    expect(extraction.dynamic).toEqual([]);
  });

  test('a property and a callee in one file come back in source order', () => {
    const body =
      "const a = { titleKey: 'a.first' };\nt('a.second');\nconst b = { titleKey: 'a.third' };";
    const extraction = extractKeys(body, 'a.ts', { callees: ['t'], ...options });
    expect(extraction.usages.map((usage) => usage.key)).toEqual(['a.first', 'a.second', 'a.third']);
  });

  // `stripComments` keeps strings, so a property quoted inside one (a docs example, a fix line) read
  // as a real key and was demanded of every catalog.
  test('a property written inside a string is text, not a usage', () => {
    const lines = [
      `const fix = "pass { titleKey: 'example.only' }";`,
      "const doc = `{ subject: 'example.subject' } in defineThing(`;",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text, a ${…} is the case under test
      "const tpl = `${{ titleKey: 'a.inside' }.titleKey}`;",
    ];
    const extraction = extractKeys(lines.join('\n'), 'a.ts', options);
    expect(extraction.usages.map((usage) => usage.key)).toEqual(['a.inside']);
    expect(extraction.dynamic).toEqual([]);
  });

  test('no properties declared: a titleKey is not a usage', () => {
    expect(extractKeys("const a = { titleKey: 'a.title' };").usages).toEqual([]);
  });
});

describe('extractKeys \u00B7 the literal rule', () => {
  // One regex read two adjacent strings as one literal: a key spelled "a' + 'b" reached every
  // catalog through x i18n sync.
  test('t() over a concatenation is dynamic, not a key with a quote in it', () => {
    const extraction = extractKeys("t('a.' + 'b');");
    expect(extraction.usages).toEqual([]);
    expect(extraction.dynamic.map((entry) => entry.expression)).toEqual(["'a.' + 'b'"]);
  });
});

describe('auditCatalogs \u00B7 reference', () => {
  const none = { usages: [], dynamic: [] };

  test('a key only the reference defines is missing from the other locale, and used stays source', () => {
    const report = auditCatalogs({
      extraction: none,
      catalogs: { en: { 'a.only': 'Only' }, es: {} },
      reference: 'en',
    });
    expect(report.locales.find((audit) => audit.locale === 'es')?.missing).toEqual(['a.only']);
    expect(report.locales.find((audit) => audit.locale === 'en')?.missing).toEqual([]);
    expect(report.used).toEqual([]);
    expect(report.required).toEqual(['a.only']);
    expect(report.ok).toBe(false);
  });

  test('plural families compare by stem: ja with _other alone and pl with _few both pass', () => {
    const report = auditCatalogs({
      extraction: none,
      catalogs: {
        en: {
          items_one: '{count} item',
          items_other: '{count} items',
          pair: 'x',
          pair_plural: 'y',
        },
        ja: { items_other: '{count} \u500B', pair: 'x' },
        pl: { items_one: 'a', items_few: 'b', items_many: 'c', pair_plural: 'y' },
      },
      reference: 'en',
    });
    expect(report.locales.flatMap((audit) => audit.missing)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('select and ordinal families: used by their stem, owed by stem, and _other required', () => {
    const report = auditCatalogs({
      extraction: extractKeys("t('invite', { select, count }); t('place', { ordinal: n });"),
      catalogs: {
        en: {
          invite_select_female_one: 'a',
          invite_select_other_one: 'b',
          place_ordinal_one: '{ordinal}st',
          place_ordinal_other: '{ordinal}th',
        },
        tr: { invite_select_other: 'x', place_ordinal_other: '{ordinal}.' },
        de: { invite_select_female: 'sie', place_ordinal_other: '{ordinal}.' },
      },
      reference: 'en',
    });
    const audit = (locale: string) => report.locales.find((each) => each.locale === locale);
    expect(audit('en')).toMatchObject({ missing: [], unused: [], incomplete: [] });
    expect(audit('tr')).toMatchObject({ missing: [], unused: [], incomplete: [] });
    expect(audit('de')?.incomplete).toEqual(['invite_select_other']);
    expect(report.ok).toBe(false);
    expect(familyIncomplete('de', audit('de')?.incomplete ?? []).code).toBe(
      'X_I18N_FAMILY_INCOMPLETE',
    );
  });

  test('a key source names itself is no family member, so it owes no _other', () => {
    const report = auditCatalogs({
      extraction: extractKeys("t('theme_select_label'); t('rank_ordinal_hint', { count });"),
      catalogs: {
        en: {
          theme_select_label: 'Theme',
          rank_ordinal_hint_one: 'a',
          rank_ordinal_hint_other: 'b',
        },
      },
      reference: 'en',
    });
    expect(report.locales[0]?.incomplete).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('a suffix that is no plural category is its own key, not a stem', () => {
    const report = auditCatalogs({
      extraction: none,
      catalogs: { en: { sort_order: 'Order' }, es: { sort: 'Orden' } },
      reference: 'en',
    });
    expect(report.locales.find((audit) => audit.locale === 'es')?.missing).toEqual(['sort_order']);
  });

  test('a key only another locale holds is not a gap in the reference', () => {
    const report = auditCatalogs({
      extraction: none,
      catalogs: { en: {}, es: { 'a.extra': 'Extra' } },
      reference: 'en',
    });
    expect(report.ok).toBe(true);
  });

  test('no reference, or a reference no catalog answers: only source is compared', () => {
    const catalogs = { en: { 'a.only': 'Only' }, es: {} };
    expect(auditCatalogs({ extraction: none, catalogs }).ok).toBe(true);
    expect(auditCatalogs({ extraction: none, catalogs, reference: 'de' }).ok).toBe(true);
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
