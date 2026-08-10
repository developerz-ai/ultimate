import { describe, expect, test } from 'bun:test';
import type { Catalog } from './catalog';
import { flattenCatalog } from './catalog';
import { createTranslator, isMiss, type TranslationKey, type Translator } from './translator';

const en = flattenCatalog({
  nav: { home: 'Home', billing: 'Billing' },
  approvals: {
    empty: 'Nothing waiting on you.',
    pending: '{count} pending approval',
    pending_plural: '{count} pending approvals',
  },
  greeting: 'Hi {name}, you have {count} message',
  greeting_plural: 'Hi {name}, you have {count} messages',
});

// Polish has one/few/many/other — an `n === 1` translator gets 2 of these 3 wrong.
const pl = flattenCatalog({
  files: {
    n_one: '{count} plik',
    n_few: '{count} pliki',
    n_many: '{count} plików',
    n_other: '{count} pliku',
  },
});

describe('createTranslator', () => {
  test('renders a missing key loudly instead of falling back', () => {
    const t = createTranslator(en, 'en');
    expect(t('nav.settings')).toBe('⟦nav.settings⟧');
    expect(isMiss(t('nav.settings'))).toBe(true);
    expect(t.has('nav.settings')).toBe(false);
    // the loud form must not be mistaken for a real string
    expect(t('nav.home')).toBe('Home');
    expect(isMiss(t('nav.home'))).toBe(false);
  });

  test('interpolates and reports a missing variable loudly too', () => {
    const t = createTranslator(en, 'en');
    expect(t('greeting', { name: 'Ada', count: 1 })).toBe('Hi Ada, you have 1 message');
    expect(t('greeting', { count: 1 })).toBe('Hi ⟦name⟧, you have 1 message');
  });

  test('two-form authoring: key / key_plural', () => {
    const t = createTranslator(en, 'en');
    expect(t('approvals.pending', { count: 1 })).toBe('1 pending approval');
    expect(t('approvals.pending', { count: 4 })).toBe('4 pending approvals');
    expect(t('approvals.pending', { count: 0 })).toBe('0 pending approvals');
  });

  test('selects the CLDR plural form for a three-form locale', () => {
    const t = createTranslator(pl, 'pl');
    expect(t('files.n', { count: 1 })).toBe('1 plik');
    expect(t('files.n', { count: 3 })).toBe('3 pliki');
    expect(t('files.n', { count: 5 })).toBe('5 plików');
    expect(t('files.n', { count: 22 })).toBe('22 pliki');
    expect(t('files.n', { count: 25 })).toBe('25 plików');
    expect(t('files.n', { count: 1.5 })).toBe('1.5 pliku');
  });

  test('has() accepts a key that only exists in plural variants', () => {
    const t = createTranslator(pl, 'pl');
    expect(t.has('files.n')).toBe(true);
    expect(t.raw('files.n')).toBeUndefined();
    expect(t.raw('files.n_one')).toBe('{count} plik');
  });

  test('exposes its locale and keys', () => {
    const t = createTranslator(en, 'en');
    expect(t.locale).toBe('en');
    expect(t.keys()).toContain('approvals.empty');
  });
});

/**
 * These assertions fail at `tsc`, not at runtime: every `@ts-expect-error` below is a key an
 * app must not be able to write. The `expect()` calls exist so the values are not dead code.
 */
const sample = {
  nav: { home: 'Home', settings: { profile: 'Profile' } },
  files: { n_one: '{count} file', n_other: '{count} files' },
  rows: { n_one: '{count} row', n_few: '{count} rows', n_many: '{count} rows' },
  queue: { n: '{count} job waiting', n_plural: '{count} jobs waiting' },
  greeting: 'Hi {name}',
};

describe('TranslationKey', () => {
  test('admits nested dot-paths, leaves and plural stems', () => {
    const nested: TranslationKey<typeof sample> = 'nav.settings.profile';
    const shallow: TranslationKey<typeof sample> = 'nav.home';
    const root: TranslationKey<typeof sample> = 'greeting';
    const variant: TranslationKey<typeof sample> = 'files.n_one';
    // `t('files.n', { count })` is how plural selection is called — every stem must be a key.
    const twoForm: TranslationKey<typeof sample> = 'files.n';
    const cldr: TranslationKey<typeof sample> = 'rows.n';
    const shortcut: TranslationKey<typeof sample> = 'queue.n_plural';

    expect([nested, shallow, root, variant, twoForm, cldr, shortcut]).toEqual([
      'nav.settings.profile',
      'nav.home',
      'greeting',
      'files.n_one',
      'files.n',
      'rows.n',
      'queue.n_plural',
    ]);
  });

  test('rejects a key the catalog does not define', () => {
    // @ts-expect-error — a typo is a build error, not a ⟦key⟧ someone spots in production
    const typo: TranslationKey<typeof sample> = 'nav.hom';
    // @ts-expect-error — a branch is not a string leaf
    const branch: TranslationKey<typeof sample> = 'nav.settings';
    // @ts-expect-error — a plural stem exists, an invented suffix does not
    const suffix: TranslationKey<typeof sample> = 'files.n_lots';

    // Joined, because the declared type is the narrow union the literals were rejected by.
    expect([typo, branch, suffix].join(' ')).toBe('nav.hom nav.settings files.n_lots');
  });

  test('degrades to string for a flat catalog, so untyped callers are unaffected', () => {
    const flat: TranslationKey<Catalog> = 'anything.at.all';
    const indexed: TranslationKey<Record<string, string>> = 'anything.at.all';

    expect([flat, indexed]).toEqual(['anything.at.all', 'anything.at.all']);
  });

  test('is the key type the Translator call signature carries', () => {
    const typed: Parameters<Translator<typeof sample>>[0] = 'files.n';
    // @ts-expect-error — the type argument reaches the call signature, so this call site fails
    const untyped: Parameters<Translator<typeof sample>>[0] = 'files.none';
    // No type argument ⇒ `string`, which is what @ultimat3/ui and @ultimat3/mail rely on.
    const bare: Parameters<Translator>[0] = 'whatever.a.caller.passes';

    expect([typed, untyped, bare]).toEqual(['files.n', 'files.none', 'whatever.a.caller.passes']);
  });
});
