import { describe, expect, test } from 'bun:test';
import { flattenCatalog } from './catalog';
import { createTranslator, isMiss } from './translator';

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
