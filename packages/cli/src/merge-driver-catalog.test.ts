// The catalog merge: every key either side added survives, and two wordings of one key do not.

import { describe, expect, test } from 'bun:test';
import { mergeCatalogText } from './merge-driver-catalog';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

describe('unit · mergeCatalogText', () => {
  const base = json({ a: { x: 'X' } });

  test('both sides add keys under one parent: all kept, sorted, either direction', () => {
    const ours = json({ a: { beta: 'B', x: 'X' } });
    const theirs = json({ a: { alpha: 'A', x: 'X' } });
    const expected = json({ a: { alpha: 'A', beta: 'B', x: 'X' } });
    expect(mergeCatalogText(base, ours, theirs)).toBe(expected);
    expect(mergeCatalogText(base, theirs, ours)).toBe(expected);
  });

  test('one side rewording and the other adding is no conflict', () => {
    expect(mergeCatalogText(base, json({ a: { x: 'Y' } }), json({ a: { n: 'N', x: 'X' } }))).toBe(
      json({ a: { n: 'N', x: 'Y' } }),
    );
  });

  test('a key one side deleted stays deleted', () => {
    expect(mergeCatalogText(base, json({ a: {} }), json({ a: { x: 'X', y: 'Y' } }))).toBe(
      json({ a: { y: 'Y' } }),
    );
  });

  test('two wordings of one key are a conflict', () => {
    expect(
      mergeCatalogText(base, json({ a: { x: 'Y' } }), json({ a: { x: 'Z' } })),
    ).toBeUndefined();
  });

  test('deleted on one side, reworded on the other is a conflict', () => {
    expect(mergeCatalogText(base, json({ a: {} }), json({ a: { x: 'Z' } }))).toBeUndefined();
  });

  test('a side that is not JSON falls through to the text merge', () => {
    expect(mergeCatalogText(base, '<<<<<<< HEAD\n', base)).toBeUndefined();
  });

  test('a hand-grouped catalog keeps its order, the new key after it', () => {
    const grouped = json({ z: '1', a: '2' });
    expect(mergeCatalogText(grouped, json({ z: '1', a: '2', m: '3' }), grouped)).toBe(
      json({ z: '1', a: '2', m: '3' }),
    );
  });

  test('two branches adding the first keys to an absent file merge from an empty base', () => {
    expect(mergeCatalogText('', json({ b: '1' }), json({ a: '2' }))).toBe(json({ a: '2', b: '1' }));
  });
});
