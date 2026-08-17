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

  test('a __proto__ segment nests as an ordinary key and never reaches Object.prototype', () => {
    const nested = nestCatalog({ '__proto__.polluted': 'owned', 'nav.home': 'Home' });

    // The write landed on the catalog, not on every object in the process.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    // Read through a descriptor, never `nested['__proto__']`: on a normal object that expression
    // is the deprecated prototype accessor, so it would pass without proving the key is own data.
    expect(ownValue(nested, '__proto__')).toEqual({ polluted: 'owned' });

    // And it survives the round trip a written catalog file actually takes.
    const reread: unknown = JSON.parse(JSON.stringify(nested));
    expect(loadCatalog(reread)).toEqual({ '__proto__.polluted': 'owned', 'nav.home': 'Home' });
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  test('a bare __proto__ leaf is a key, not a prototype write', () => {
    // Built through `JSON.parse`, the way a catalog reaches this function: an object *literal*
    // spelt `{ __proto__: 'Home' }` sets the prototype instead of declaring the key, so it could
    // never reproduce what a file on disk carries.
    const flat = JSON.parse('{"__proto__":"Home"}') as Record<string, string>;
    const nested = nestCatalog(flat);
    expect(ownValue(nested, '__proto__')).toBe('Home');
    expect(Object.getPrototypeOf(nested)).toBeNull();
  });
});

/** The own data property under `key`, or `undefined` — never the `__proto__` accessor. */
function ownValue(node: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(node, key)?.value;
}

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
    // `admin.*` is the one namespace the FRAMEWORK renders itself (`@ultimat3/admin`'s views), so
    // it is pinned on a key those views actually pass to `t()`. This assertion used to name
    // `admin.nav.jobs`, from a block describing an admin UI that no longer existed — the shipped
    // panel rendered ⟦admin.list.loading⟧ and this test was green. `scripts/i18n-catalog.ts` is
    // what now holds the whole namespace to the source, in both directions.
    expect(FRAMEWORK_CATALOG['admin.list.loading']).toBe('Loading…');
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
