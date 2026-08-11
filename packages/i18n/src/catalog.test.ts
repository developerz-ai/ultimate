import { describe, expect, test } from 'bun:test';
import {
  catalogKeys,
  flattenCatalog,
  loadCatalog,
  mergeCatalogs,
  missingFrom,
  nestCatalog,
} from './catalog';
import { FRAMEWORK_CATALOG } from './framework';

describe('nestCatalog', () => {
  test('is flattenCatalog inverted — a dot-key catalog becomes the authored shape', () => {
    const flat = { 'nav.home': 'Home', 'nav.deep.deeper': 'Deep', top: 'Top' };
    expect(nestCatalog(flat)).toEqual({
      nav: { deep: { deeper: 'Deep' }, home: 'Home' },
      top: 'Top',
    });
    expect(flattenCatalog(nestCatalog(flat))).toEqual(flat);
  });

  test('what it produces is what parseNestedCatalog accepts — the round-trip that matters', () => {
    expect(loadCatalog(nestCatalog({ 'a.b.c': 'x' }))).toEqual({ 'a.b.c': 'x' });
  });

  test('a branch that collides with a leaf is X_CATALOG_INVALID, not a silent overwrite', () => {
    expect(codeOf(() => nestCatalog({ nav: 'Home', 'nav.home': 'Home' }))).toBe(
      'X_CATALOG_INVALID',
    );
    expect(codeOf(() => nestCatalog({ 'nav.home': 'Home', nav: 'Home' }))).toBe(
      'X_CATALOG_INVALID',
    );
  });
});

describe('flattenCatalog', () => {
  test('nested authoring becomes dot-key lookup', () => {
    const flat = flattenCatalog({
      nav: { home: 'Home', deep: { deeper: 'Deep' } },
      approvals: { pending: '{count} pending approval' },
    });
    expect(flat['nav.home']).toBe('Home');
    expect(flat['nav.deep.deeper']).toBe('Deep');
    expect(catalogKeys(flat)).toEqual(['approvals.pending', 'nav.deep.deeper', 'nav.home']);
  });

  test('rejects a non-string leaf with X_CATALOG_INVALID', () => {
    // The two mistakes translators actually make: an array and a number.
    expect(codeOf(() => flattenCatalog(loadFixture({ nav: { items: ['a', 'b'] } })))).toBe(
      'X_CATALOG_INVALID',
    );
    expect(codeOf(() => loadCatalog({ nav: { count: 3 } }))).toBe('X_CATALOG_INVALID');
  });

  test('rejects a nested branch colliding with a dotted key', () => {
    expect(codeOf(() => loadCatalog({ 'nav.home': 'A', nav: { home: 'B' } }))).toBe(
      'X_CATALOG_INVALID',
    );
  });
});

describe('mergeCatalogs', () => {
  test('later catalogs win so an app can override framework strings', () => {
    const framework = flattenCatalog({ errors: { notFound: { title: 'Page not found' } } });
    const app = flattenCatalog({ errors: { notFound: { title: 'Lost?' } } });
    const merged = mergeCatalogs(framework, app);
    expect(merged['errors.notFound.title']).toBe('Lost?');
  });

  test('missingFrom reports the gap between two locales', () => {
    const en = flattenCatalog({ a: 'A', b: 'B', c: 'C' });
    const es = flattenCatalog({ a: 'A' });
    expect(missingFrom(en, es)).toEqual(['b', 'c']);
  });
});

describe('framework catalog', () => {
  test('ships the strings every generated app needs', () => {
    expect(FRAMEWORK_CATALOG['errors.notFound.title']).toBe('Page not found');
    expect(FRAMEWORK_CATALOG['pagination.page']).toBe('Page {page} of {pages}');
    expect(FRAMEWORK_CATALOG['auth.signIn.submit']).toBe('Sign in');
    expect(FRAMEWORK_CATALOG['admin.nav.jobs']).toBe('Jobs');
  });
});

/** Cast-free way to hand the flattener a deliberately invalid shape. */
function loadFixture(value: unknown): Parameters<typeof flattenCatalog>[0] {
  return value as Parameters<typeof flattenCatalog>[0];
}

/** Assert on the stable error code, never on the rendered message. */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'no-throw';
}
