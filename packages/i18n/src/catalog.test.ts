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

  // `loadCatalog` refuses the shape above at the PARSE step — a dot is not a key segment — so
  // the flattener's own collision guard is never reached through it. `flattenCatalog` is exported
  // and takes the nested shape directly, and that is the door where one dotted key and one branch
  // would otherwise both write `nav.home` and the last writer would silently win.
  test('the flattener refuses a collision on its own, naming the path both keys claim', () => {
    const collide = () => flattenCatalog(loadFixture({ 'nav.home': 'A', nav: { home: 'B' } }));
    expect(codeOf(collide)).toBe('X_CATALOG_INVALID');
    expect(causeOf(collide)).toContain('nav.home');
    expect(causeOf(collide)).toContain('duplicate key');
    // Order-independent: the branch first is the same collision.
    const reversed = () => flattenCatalog(loadFixture({ nav: { home: 'B' }, 'nav.home': 'A' }));
    expect(codeOf(reversed)).toBe('X_CATALOG_INVALID');
    // A dotted key with no branch beside it still flattens, so the guard is on the collision
    // and not on the dot.
    expect(flattenCatalog(loadFixture({ 'nav.home': 'A' }))['nav.home']).toBe('A');
  });
});

describe('prototype safety', () => {
  test('flattenCatalog keeps __proto__ as a key instead of dropping it on the setter', () => {
    // `JSON.parse`, never an object literal: `{ __proto__: 'Hello' }` in source sets the
    // prototype, so it could not reproduce what a catalog file on disk carries.
    const flat = loadCatalog(JSON.parse('{"__proto__":"Hello","greeting":"Hi"}'));

    expect(Object.keys(flat).sort()).toEqual(['__proto__', 'greeting']);
    expect(ownValue(flat, '__proto__')).toBe('Hello');
    expect(Object.getPrototypeOf(flat)).toBeNull();
    expect(Object.hasOwn(Object.prototype, 'greeting')).toBe(false);
  });

  test('a flat catalog reads absent for every Object.prototype member', () => {
    const flat = loadCatalog({ greeting: 'Hi' });
    const inherited = ['valueOf', 'constructor', 'toString', 'hasOwnProperty', '__proto__'];

    // A RAW index, deliberately: that is what a consumer writes, and on a `{}` catalog every one
    // of these answered an inherited function or object rather than `undefined`.
    const read = inherited.map((key) => (flat as Record<string, unknown>)[key]);
    expect(read).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(inherited.filter((key) => Object.hasOwn(flat, key))).toEqual([]);
  });

  test('mergeCatalogs carries the null prototype through', () => {
    const merged = mergeCatalogs(
      loadCatalog(JSON.parse('{"__proto__":"Hello"}')),
      loadCatalog({ greeting: 'Hi' }),
    );

    expect(Object.getPrototypeOf(merged)).toBeNull();
    expect(Object.keys(merged).sort()).toEqual(['__proto__', 'greeting']);
    expect(ownValue(merged, '__proto__')).toBe('Hello');
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

/** Assert on the cause where the code alone cannot tell two refusals apart. */
function causeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { cause?: unknown }).cause);
  }
  return 'no-throw';
}
