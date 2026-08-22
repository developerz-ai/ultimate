import { describe, expect, test } from 'bun:test';
import { MAX_CACHED_FORMATTERS } from '@ultimat3/core';
import {
  interpolate,
  PLURAL_CATEGORIES,
  placeholdersOf,
  pluralCategory,
  pluralKeyCandidates,
  pluralVariantsOf,
  selectPluralKey,
} from './interpolate';

describe('interpolate', () => {
  test('substitutes and escapes braces', () => {
    expect(interpolate('Hi {name}', { name: 'Ada' })).toBe('Hi Ada');
    expect(interpolate('{{literal}} {name}', { name: 'x' })).toBe('{literal} x');
    expect(interpolate('no vars')).toBe('no vars');
  });

  test('renders an unknown variable loudly', () => {
    expect(interpolate('Hi {name}', {})).toBe('Hi ⟦name⟧');
  });

  test('an inherited property is not a variable', () => {
    // Without an own-property guard these walk `Object.prototype` and render a function's
    // source, `[object Object]` or `true` into a page — the same prototype reach
    // `catalog.ts` shuts off by nesting into null-prototype nodes.
    for (const inherited of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(interpolate(`x {${inherited}} y`, {})).toBe(`x ⟦${inherited}⟧ y`);
    }
  });

  test('an own property named like a prototype member still substitutes', () => {
    expect(interpolate('{toString}', { toString: 'ok' })).toBe('ok');
    expect(
      interpolate('{constructor}', Object.assign(Object.create(null), { constructor: 1 })),
    ).toBe('1');
  });

  test('un-escapes a closing brace with no opening one in sight', () => {
    // The `{`-only fast path let one escape mean two things: collapsed inside `{{a}}b`,
    // untouched in `a}}b`.
    expect(interpolate('a}}b')).toBe('a}b');
    expect(interpolate('{{a}}b')).toBe('{a}b');
    expect(interpolate('}}', { x: 1 })).toBe('}');
    expect(interpolate('a}b')).toBe('a}b');
    expect(interpolate('no braces at all')).toBe('no braces at all');
  });

  test('lists the placeholders a template needs', () => {
    expect(placeholdersOf('{from}–{to} of {total}').sort()).toEqual(['from', 'to', 'total']);
  });
});

describe('plural selection', () => {
  test('uses CLDR categories, not an English one/other split', () => {
    expect(pluralCategory(1, 'ru')).toBe('one');
    expect(pluralCategory(2, 'ru')).toBe('few');
    expect(pluralCategory(5, 'ru')).toBe('many');
    expect(pluralCategory(21, 'ru')).toBe('one');
    expect(pluralCategory(0, 'en')).toBe('other');
    expect(pluralCategory(2, 'ja')).toBe('other');
  });

  test('candidate order prefers the exact category, then the two-form shortcut', () => {
    expect(pluralKeyCandidates('items', 5, 'ru')).toEqual([
      'items_many',
      'items_plural',
      'items_other',
      'items',
      'items_one',
    ]);
    // `one` keeps the BARE key second — in the two-form shortcut it is the singular — but still
    // ends on the same set every other category probes, because `Translator.has()` promises all
    // four. A shorter chain is one function in this package promising a string the other refuses.
    expect(pluralKeyCandidates('items', 1, 'ru')).toEqual([
      'items_one',
      'items',
      'items_plural',
      'items_other',
    ]);
  });

  test('never probes the same candidate twice', () => {
    // `other` used to emit `items_other` at both the category slot and the fallback slot.
    for (const [count, locale] of [
      [0, 'en'],
      [1, 'en'],
      [5, 'ru'],
      [2, 'ar'],
    ] as const) {
      const candidates = pluralKeyCandidates('items', count, locale);
      expect(candidates).toEqual([...new Set(candidates)]);
    }
  });

  test('a `one` count still resolves when only the plural forms are authored', () => {
    const otherOnly = new Set(['items_other', 'items_plural']);
    expect(selectPluralKey('items', 1, 'en', (key) => otherOnly.has(key))).toBe('items_plural');
  });

  test('falls back through the candidate list', () => {
    const twoForm = new Set(['items', 'items_plural']);
    expect(selectPluralKey('items', 5, 'ru', (key) => twoForm.has(key))).toBe('items_plural');
    expect(selectPluralKey('items', 1, 'ru', (key) => twoForm.has(key))).toBe('items');
    expect(selectPluralKey('nope', 5, 'ru', () => false)).toBe('nope');
  });
});

describe('pluralVariantsOf', () => {
  test('is the two-form shortcut plus every CLDR category, in probe order', () => {
    expect(pluralVariantsOf('items')).toEqual([
      'items_plural',
      'items_zero',
      'items_one',
      'items_two',
      'items_few',
      'items_many',
      'items_other',
    ]);
    expect(pluralVariantsOf('items')).toHaveLength(PLURAL_CATEGORIES.length + 1);
    // The bare key is NOT a variant — a variant is a suffixed spelling of it.
    expect(pluralVariantsOf('items')).not.toContain('items');
  });

  test('covers every candidate any locale and count can ask for', () => {
    // The contract that matters: a tool deleting "variants" must not delete a key a lookup
    // would still probe. `ar` reaches zero/two, `ru` reaches few/many, `en` reaches one/other.
    const variants = new Set(pluralVariantsOf('items'));
    for (const locale of ['en', 'ru', 'ar', 'pl', 'ja', 'cy']) {
      for (const count of [0, 1, 2, 3, 5, 11, 100]) {
        for (const candidate of pluralKeyCandidates('items', count, locale)) {
          if (candidate === 'items') continue;
          expect(variants.has(candidate)).toBe(true);
        }
      }
    }
  });
});

describe('pluralRulesFor', () => {
  test('an unparseable locale tag degrades to English instead of breaking the render', () => {
    // `new Intl.PluralRules('this is not a tag')` throws a RangeError, and a render must not
    // 500 because a header carried junk.
    expect(() => new Intl.PluralRules('this is not a tag')).toThrow(RangeError);
    expect(pluralCategory(1, 'this is not a tag')).toBe('one');
    expect(pluralCategory(7, 'this is not a tag')).toBe('other');
    // Cached under the bad tag, so the second call answers the same without re-throwing.
    expect(pluralCategory(1, 'this is not a tag')).toBe('one');
    expect(pluralKeyCandidates('items', 1, 'this is not a tag')).toEqual([
      'items_one',
      'items',
      'items_plural',
      'items_other',
    ]);
  });
});

describe('the plural-rules cache', () => {
  /** Records every tag `Intl.PluralRules` is actually constructed with, and restores itself. */
  function recordConstructions(run: (built: unknown[]) => void): void {
    const built: unknown[] = [];
    const real = Intl.PluralRules;
    // `defineProperty` and not an assignment: `Intl.PluralRules` is declared read-only, so
    // `Intl.PluralRules = proxy` is a compile error and the cast that silences it is the `any`
    // this repo does not allow.
    const install = (value: typeof Intl.PluralRules): void => {
      Object.defineProperty(Intl, 'PluralRules', { value, configurable: true, writable: true });
    };
    install(
      new Proxy(real, {
        construct(target, args, newTarget) {
          built.push(args[0]);
          return Reflect.construct(target, args, newTarget);
        },
      }),
    );
    try {
      run(built);
    } finally {
      install(real);
    }
  }

  test('is bounded — the oldest tag is evicted, not kept for the life of the process', () => {
    // `locale` is whatever `Accept-Language` sent, and `pluralCategory` is exported raw. Keyed
    // raw into an unbounded `Map`, every distinct-but-valid tag a client chose to send bought a
    // PERMANENT `Intl.PluralRules`. Asserted where the bound is decided — ICU allocates natively,
    // so the JS heap never showed the growth: first key in is first key out.
    pluralCategory(1, 'en-x-rules-oldest');
    for (let index = 0; index < MAX_CACHED_FORMATTERS; index += 1) {
      pluralCategory(1, `en-x-rules-a${index}`);
    }
    recordConstructions((built) => {
      pluralCategory(1, 'en-x-rules-oldest');
      expect(built).toEqual(['en-x-rules-oldest']);
    });
  });

  test('two spellings of one tag share one entry', () => {
    pluralCategory(1, 'en-x-rules-warm');
    recordConstructions((built) => {
      // The canonical tag is the key AND what reaches `Intl`, so a header spelling one locale
      // three ways does not mint three permanent rule objects.
      expect(pluralCategory(1, 'EN-x-RULES-WARM')).toBe('one');
      expect(built).toEqual([]);
    });
  });
});
