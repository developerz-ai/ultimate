// `format.ts`'s formatters are built once per locale and options, never once per call: a feed of
// 10k timestamps paid an `Intl` construction for each, which is most of what rendering it cost.

import { afterEach, describe, expect, test } from 'bun:test';
import { formatRelative, ordinal } from './format';
import { fromIso } from './instant';

const RealRelative = Intl.RelativeTimeFormat;
const RealPlural = Intl.PluralRules;

/** `Intl`'s constructors are typed read-only; the swap below is the one place that writes them. */
const writable = Intl as unknown as {
  RelativeTimeFormat: typeof Intl.RelativeTimeFormat;
  PluralRules: typeof Intl.PluralRules;
};

afterEach(() => {
  writable.RelativeTimeFormat = RealRelative;
  writable.PluralRules = RealPlural;
});

/** Swap `Intl[name]` for a subclass that counts constructions, for the length of one test. */
function countConstructions(name: 'RelativeTimeFormat' | 'PluralRules'): { count: number } {
  const counter = { count: 0 };
  if (name === 'RelativeTimeFormat') {
    writable.RelativeTimeFormat = class extends RealRelative {
      constructor(...args: ConstructorParameters<typeof RealRelative>) {
        super(...args);
        counter.count += 1;
      }
    };
  } else {
    writable.PluralRules = class extends RealPlural {
      constructor(...args: ConstructorParameters<typeof RealPlural>) {
        super(...args);
        counter.count += 1;
      }
    } as typeof Intl.PluralRules;
  }
  return counter;
}

describe('formatter reuse', () => {
  test('formatRelative builds one Intl.RelativeTimeFormat per locale and options', () => {
    const counter = countConstructions('RelativeTimeFormat');
    const now = fromIso('2026-03-14T08:00:00Z');
    for (let index = 0; index < 50; index += 1) {
      formatRelative(fromIso('2026-03-17T08:00:00Z'), { locale: 'fr-CA', zone: 'UTC', now });
      formatRelative(now, { locale: 'fr-CA', zone: 'UTC', now, style: 'short' });
    }
    expect(counter.count).toBeLessThanOrEqual(2);
  });

  test('formatRelative still answers per locale and options, not from the first one cached', () => {
    const now = fromIso('2026-03-14T08:00:00Z');
    const at = fromIso('2026-03-15T08:00:00Z');
    expect(formatRelative(at, { locale: 'en', zone: 'UTC', now })).toBe('tomorrow');
    expect(formatRelative(at, { locale: 'en', zone: 'UTC', now, numeric: 'always' })).toBe(
      'in 1 day',
    );
    expect(formatRelative(at, { locale: 'de', zone: 'UTC', now })).toBe('morgen');
  });

  test('ordinal builds its plural rules once', () => {
    const counter = countConstructions('PluralRules');
    for (let index = 1; index <= 50; index += 1) ordinal(index);
    expect(counter.count).toBeLessThanOrEqual(1);
    expect([1, 2, 3, 4, 11, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '22nd']);
  });
});
