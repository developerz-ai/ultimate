/**
 * unit — the checks `x verify` runs on i18n, kept here so they also fail in a plain `bun test`.
 * A catalog test is the cheapest test in the repo and catches the most embarrassing bug.
 */

import { expect, test } from 'bun:test';
import en from '../catalogs/en.json';
import es from '../catalogs/es.json';

type Node = { [key: string]: string | Node };

const flatten = (node: Node, prefix = ''): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      out.set(path, value);
      continue;
    }
    for (const [nested, nestedValue] of flatten(value, path)) out.set(nested, nestedValue);
  }
  return out;
};

const flatEn = flatten(en as Node);
const flatEs = flatten(es as Node);

/**
 * An ORDINAL family's members are the locale's CLDR categories, not a key space the two catalogs
 * share: English says 1st/2nd/3rd/4th (`one`, `two`, `few`, `other`), Spanish one form (`other`).
 */
const ORDINAL = /_ordinal_[a-z]+$/;
const ordinalStem = (key: string): string => key.replace(ORDINAL, '');

test('both catalogs describe exactly the same key space', () => {
  const shared = (key: string): boolean => !ORDINAL.test(key);
  const missingInEs = [...flatEn.keys()].filter((key) => shared(key) && !flatEs.has(key));
  const extraInEs = [...flatEs.keys()].filter((key) => shared(key) && !flatEn.has(key));

  expect(missingInEs).toEqual([]);
  expect(extraInEs).toEqual([]);
  expect(flatEn.size).toBeGreaterThan(100);
});

test('no value is blank, and no Spanish value is a copy-paste of the English one', () => {
  const blank = [...flatEs].filter(([, value]) => value.trim().length === 0);
  expect(blank).toEqual([]);

  // Proper nouns and plan names are legitimately identical; anything longer is untranslated copy.
  const suspicious = [...flatEs].filter(
    ([key, value]) => value.length > 24 && value === flatEn.get(key),
  );
  expect(suspicious).toEqual([]);
});

test('interpolation slots match between locales', () => {
  const slots = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  const mismatched = [...flatEn].filter(([key, value]) => {
    const translated = flatEs.get(key);
    return translated !== undefined && slots(value).join() !== slots(translated).join();
  });

  expect(mismatched.map(([key]) => key)).toEqual([]);
});

test('every ordinal family ends in `_ordinal_other` in both locales: the form every number reaches', () => {
  const stems = new Set(
    [...flatEn.keys(), ...flatEs.keys()].filter((key) => ORDINAL.test(key)).map(ordinalStem),
  );
  expect(stems.size).toBeGreaterThan(0);
  for (const stem of stems) {
    expect(flatEn.has(`${stem}_ordinal_other`)).toBe(true);
    expect(flatEs.has(`${stem}_ordinal_other`)).toBe(true);
  }
});

test('every plural key carries both categories Spanish and English need', () => {
  // Underscore suffixes on the leaf, never a nested `{ one, other }` branch: `selectPluralKey`
  // probes `<stem>_one` / `<stem>_other`, so a nested branch renders `⟦key⟧` at every call site.
  // A `select`/`ordinal` family's `_other` is its fallback, not a plural: it has no `_one` twin.
  const family = /_(?:select|ordinal)_[A-Za-z0-9-]+$/;
  const stems = [...flatEn.keys()]
    .filter((key) => !family.test(key) && (key.endsWith('_one') || key.endsWith('_other')))
    .map((key) => key.slice(0, key.lastIndexOf('_')));

  // Without this the loop below is vacuous: rename the convention and the test stays green.
  expect(new Set(stems).size).toBeGreaterThan(0);

  for (const stem of new Set(stems)) {
    expect(flatEn.has(`${stem}_one`)).toBe(true);
    expect(flatEn.has(`${stem}_other`)).toBe(true);
    expect(flatEs.has(`${stem}_one`)).toBe(true);
    expect(flatEs.has(`${stem}_other`)).toBe(true);
  }
});
