// Pure-logic coverage for `x i18n`'s facts: the source scan skips test files, catalogs flatten
// through `loadCatalog` (never a bare `JSON.parse`), the default-locale fallback chain, and the
// seed/sync key math that must never touch an existing translated value.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '@ultimat3/i18n';
import {
  auditApp,
  loadCatalogs,
  resolveDefaultLocale,
  runtimeKeyPatterns,
  scanSource,
  seedCatalog,
  serializeCatalog,
  syncCatalog,
} from './i18n-audit';

let root = '';

function tempRoot(prefix: string): string {
  root = mkdtempSync(join(tmpdir(), prefix));
  return root;
}

/** `loadCatalogs`/`resolveDefaultLocale` throw from inside an `async function`, so a bad catalog
 * surfaces as a rejection — never a synchronous throw a plain try/catch around the call would see. */
async function rejectedBy(call: () => Promise<unknown>): Promise<{ code?: string }> {
  try {
    await call();
  } catch (error) {
    return error as { code?: string };
  }
  return expect.unreachable('expected a rejection');
}

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('unit · scanSource', () => {
  test('finds a static key and a dynamic call, and skips test files entirely', async () => {
    const dir = tempRoot('x-i18n-scan-');
    // extractKeys is a deliberate lexer-free regex scan (see extract.ts) — it does not strip
    // comments, so this fixture stays code-only rather than encode a false "comments are ignored"
    // expectation.
    await Bun.write(
      join(dir, 'app/page.ts'),
      ["const greet = t('greeting.hello');", 'const dyn = t(someVariable);', ''].join('\n'),
    );
    await Bun.write(join(dir, 'app/page.test.ts'), "t('fixture.only');\n");

    const extraction = await scanSource(dir);

    expect(extraction.usages).toHaveLength(1);
    expect(extraction.usages[0]?.key).toBe('greeting.hello');
    expect(extraction.usages[0]?.file).toBe('app/page.ts');
    expect(extraction.dynamic).toHaveLength(1);
    expect(extraction.dynamic[0]?.file).toBe('app/page.ts');
    expect(extraction.usages.some((usage) => usage.key === 'fixture.only')).toBe(false);
  });
});

describe('unit · loadCatalogs', () => {
  test('flattens a nested catalog and loads a flat one, keyed by filename stem', async () => {
    const dir = tempRoot('x-i18n-load-');
    // Catalogs are authored nested (see examples/dummy/packages/i18n/catalogs/en.json) — a flat
    // key with a literal dot in it fails parseNestedCatalog's per-segment check, so both fixtures
    // below nest one level rather than pre-flatten.
    await Bun.write(
      join(dir, 'packages/i18n/catalogs/en.json'),
      JSON.stringify({ greeting: { hello: 'Hello' } }),
    );
    await Bun.write(
      join(dir, 'packages/i18n/catalogs/es.json'),
      JSON.stringify({ greeting: { hello: 'Hola' } }),
    );

    const catalogs = await loadCatalogs(dir);

    expect(catalogs['en']).toEqual({ 'greeting.hello': 'Hello' });
    expect(catalogs['es']).toEqual({ 'greeting.hello': 'Hola' });
  });

  test('no catalogs directory on disk yields {}, not a throw', async () => {
    const dir = tempRoot('x-i18n-load-empty-');
    expect(await loadCatalogs(dir)).toEqual({});
  });

  test('invalid JSON syntax is X_CATALOG_INVALID, not a bare SyntaxError', async () => {
    const dir = tempRoot('x-i18n-load-badjson-');
    await Bun.write(join(dir, 'packages/i18n/catalogs/en.json'), 'not json{');
    const failure = await rejectedBy(() => loadCatalogs(dir));
    expect(failure).toBeUltimateError('X_CATALOG_INVALID');
  });

  test('a nested array authored by hand is rejected, not silently flattened', async () => {
    const dir = tempRoot('x-i18n-load-badshape-');
    // Catalogs are flat; a hand-authored array is the exact past bug loadCatalog exists to catch.
    await Bun.write(
      join(dir, 'packages/i18n/catalogs/en.json'),
      JSON.stringify({ greeting: ['Hello', 'Hi'] }),
    );
    const failure = await rejectedBy(() => loadCatalogs(dir));
    expect(failure).toBeUltimateError('X_CATALOG_INVALID');
  });
});

describe('unit · auditApp', () => {
  test('a used key missing from one locale fails only that locale, and unused is per catalog', async () => {
    const dir = tempRoot('x-i18n-audit-');
    await Bun.write(join(dir, 'app/page.ts'), "t('a.b');\n");
    // Nested authoring, as every real catalog is — flattens to 'a.b' and 'c.d'.
    await Bun.write(
      join(dir, 'packages/i18n/catalogs/en.json'),
      JSON.stringify({ a: { b: 'B' }, c: { d: 'Unused' } }),
    );
    await Bun.write(join(dir, 'packages/i18n/catalogs/es.json'), JSON.stringify({}));

    const { report } = await auditApp(dir);

    expect(report.ok).toBe(false);
    const en = report.locales.find((audit) => audit.locale === 'en');
    const es = report.locales.find((audit) => audit.locale === 'es');
    expect(en?.missing).toEqual([]);
    expect(en?.unused).toEqual(['c.d']);
    expect(es?.missing).toEqual(['a.b']);
    expect(es?.unused).toEqual([]);
  });
});

describe('unit · runtimeKeyPatterns', () => {
  test('a template literal contributes its static head, deduped and sorted', () => {
    const patterns = runtimeKeyPatterns({
      usages: [],
      dynamic: [
        { expression: '`plans.${props.plan}.name`', file: 'a.tsx', line: 1, column: 1 },
        { expression: '`plans.${props.plan}.description`', file: 'a.tsx', line: 2, column: 1 },
        { expression: '`posts.status.${post.status}`', file: 'b.tsx', line: 3, column: 1 },
      ],
    });
    expect(patterns).toEqual(['plans.*', 'posts.status.*']);
  });

  test('an expression with no static head contributes nothing — a guessed prefix hides real gaps', () => {
    expect(
      runtimeKeyPatterns({
        usages: [],
        dynamic: [
          { expression: 'key', file: 'a.ts', line: 1, column: 1 },
          { expression: "cond ? 'a.b' : 'a.c'", file: 'a.ts', line: 2, column: 1 },
          { expression: '`${anything}.name`', file: 'a.ts', line: 3, column: 1 },
        ],
      }),
    ).toEqual([]);
  });

  test('a key only reachable dynamically is not reported unused', async () => {
    const dir = tempRoot('x-i18n-runtime-');
    await Bun.write(join(dir, 'apps/web/app/page.tsx'), 't(`plans.${plan}.name`);\n');
    await Bun.write(
      join(dir, 'packages/i18n/catalogs/en.json'),
      JSON.stringify({ plans: { free: { name: 'Free' } }, orphan: 'nobody calls this' }),
    );

    const { report } = await auditApp(dir);
    expect(report.locales[0]?.unused).toEqual(['orphan']);
  });
});

describe('unit · resolveDefaultLocale', () => {
  const catalogsOf = (...locales: readonly string[]): Record<string, Record<string, string>> =>
    Object.fromEntries(locales.map((locale) => [locale, {}]));

  test('parses defineCatalogs({ default }) from the app index when present', async () => {
    const dir = tempRoot('x-i18n-default-index-');
    await Bun.write(
      join(dir, 'packages/i18n/src/index.ts'),
      [
        "import { defineCatalogs } from '@ultimat3/i18n';",
        'export const catalogs = defineCatalogs({',
        "  default: 'es',",
        '  locales: { en, es },',
        '});',
        '',
      ].join('\n'),
    );
    expect(await resolveDefaultLocale(dir, catalogsOf('en', 'es'))).toBe('es');
  });

  test('a parsed default with no matching catalog on disk falls through to en', async () => {
    const dir = tempRoot('x-i18n-default-stale-');
    await Bun.write(
      join(dir, 'packages/i18n/src/index.ts'),
      "export const catalogs = defineCatalogs({ default: 'zz', locales: { en } });\n",
    );
    expect(await resolveDefaultLocale(dir, catalogsOf('en', 'fr'))).toBe('en');
  });

  test('no index and no en falls to the sole catalog on disk', async () => {
    const dir = tempRoot('x-i18n-default-sole-');
    expect(await resolveDefaultLocale(dir, catalogsOf('fr'))).toBe('fr');
  });

  test('no index, no en, and more than one catalog is unresolved', async () => {
    const dir = tempRoot('x-i18n-default-ambiguous-');
    expect(await resolveDefaultLocale(dir, catalogsOf('fr', 'de'))).toBeUndefined();
  });
});

describe('unit · seedCatalog, syncCatalog, serializeCatalog', () => {
  test('seedCatalog copies values verbatim and sorts the keys', () => {
    const seeded = seedCatalog({ 'b.b': 'B', 'a.a': 'A' });
    expect(Object.keys(seeded)).toEqual(['a.a', 'b.b']);
    expect(seeded).toEqual({ 'a.a': 'A', 'b.b': 'B' });
  });

  test('syncCatalog adds only the missing keys and never overwrites an existing value', () => {
    const target = { 'a.a': 'translated by a human' };
    const source = { 'a.a': 'DEFAULT — must not win', 'b.b': 'DEFAULT B' };

    const { merged, added } = syncCatalog(target, source);

    expect(added).toEqual(['b.b']);
    expect(merged['a.a']).toBe('translated by a human');
    expect(merged['b.b']).toBe('DEFAULT B');
  });

  test('syncCatalog with nothing missing returns the target itself, unchanged', () => {
    const target = { 'a.a': 'A' };
    const { merged, added } = syncCatalog(target, { 'a.a': 'DEFAULT' });
    expect(added).toEqual([]);
    expect(merged).toBe(target);
  });

  test('serializeCatalog sorts keys, 2-space indents, and ends with a trailing newline', () => {
    const text = serializeCatalog({ b: '2', a: '1' });
    expect(text).toBe('{\n  "a": "1",\n  "b": "2"\n}\n');
  });

  test('serializeCatalog nests dotted keys — a flat file is one loadCatalog refuses', () => {
    const text = serializeCatalog({ 'nav.home': 'Home', 'nav.about': 'About' });
    expect(JSON.parse(text)).toEqual({ nav: { about: 'About', home: 'Home' } });
    // The whole point: what this writes must survive the loader every read goes through.
    expect(loadCatalog(JSON.parse(text))).toEqual({ 'nav.about': 'About', 'nav.home': 'Home' });
  });

  test('a written catalog round-trips back through loadCatalogs unchanged', async () => {
    const dir = tempRoot('x-i18n-roundtrip-');
    const original = { 'app.feed.heading': '{org} feed', 'site.home.title': 'Home' };
    await Bun.write(join(dir, 'packages/i18n/catalogs/en.json'), serializeCatalog(original));
    expect((await loadCatalogs(dir)).en).toEqual(original);
  });
});
