// The record `@ultimat3/mail`'s `send()` refuses on. Judged against what `t()` itself renders, so the
// two can only agree while they share one key selector.

import { describe, expect, test } from 'bun:test';
import { selectMessageKey } from './interpolate';
import { recordingTranslator } from './recording-translator';
import { catalogTranslator, isMiss } from './translator';

const CATALOG = {
  plain: 'Plain',
  hello: 'Hello {name}',
  seeded: '⟦Copied⟧',
  items_one: '{count} item',
  items_other: '{count} of {of}',
  braces: '{{literal}}',
};

const record = (locale = 'en') => recordingTranslator(catalogTranslator(CATALOG, locale));

describe('recordingTranslator', () => {
  test('answers what the translator answers, and notes nothing for a complete render', () => {
    const { t, misses } = record();
    expect(t('hello', { name: 'Ada' })).toBe('Hello Ada');
    expect(t('plain')).toBe('Plain');
    expect(t('braces')).toBe('{literal}');
    expect(misses()).toEqual([]);
  });

  test('an absent key and a seeded marker are misses on the key', () => {
    const { t, misses } = record();
    expect(isMiss(t('absent'))).toBe(true);
    expect(isMiss(t('seeded'))).toBe(true);
    expect(misses()).toEqual([
      { key: 'absent', slot: undefined },
      { key: 'seeded', slot: undefined },
    ]);
  });

  test('a slot with no own value is a miss on that slot, an inherited name included', () => {
    const { t, misses } = record();
    t('hello');
    expect(misses()).toEqual([{ key: 'hello', slot: 'name' }]);
    const inherited = record();
    inherited.t('hello', Object.create({ name: 'Ada' }));
    expect(inherited.misses()).toEqual([{ key: 'hello', slot: 'name' }]);
  });

  test('a plural family reads as t() reads it: no count is a miss, a count selects', () => {
    const { t, misses } = record();
    expect(isMiss(t('items'))).toBe(true);
    expect(misses()).toEqual([{ key: 'items', slot: undefined }]);

    const counted = record();
    expect(counted.t('items', { count: 1 })).toBe('1 item');
    expect(counted.misses()).toEqual([]);
    counted.t('items', { count: 3 });
    expect(counted.misses()).toEqual([{ key: 'items', slot: 'of' }]);
  });

  test('a repeat is one entry, sorted, and the probes pass straight through', () => {
    const { t, misses } = record();
    t('zeta');
    t('alpha');
    t('zeta');
    expect(misses().map((miss) => miss.key)).toEqual(['alpha', 'zeta']);
    expect(t.has('plain')).toBe(true);
    expect(t.raw('plain')).toBe('Plain');
    expect(t.locale).toBe('en');
  });
});

describe('selectMessageKey', () => {
  const has = (candidate: string): boolean => Object.hasOwn(CATALOG, candidate);

  test('a finite count selects by the locale, anything else leaves the key alone', () => {
    expect(selectMessageKey('items', { count: 1 }, 'en', has)).toBe('items_one');
    expect(selectMessageKey('items', { count: 2 }, 'en', has)).toBe('items_other');
    expect(selectMessageKey('items', { count: Number.NaN }, 'en', has)).toBe('items');
    expect(selectMessageKey('items', { count: 'many' }, 'en', has)).toBe('items');
    expect(selectMessageKey('items', undefined, 'en', has)).toBe('items');
  });
});
