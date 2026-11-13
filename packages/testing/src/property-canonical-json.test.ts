// Property: `canonicalJson` is the injective sharing key it claims — insertion order never
// changes it, two values share it only when they are equal, and over plain JSON it is JSON.

import { describe, expect, test } from 'bun:test';
import { canonicalJson } from '@ultimat3/core';
import { property } from './property';
import { gen } from './property-gen';

/** The same value with every object's keys inserted in reverse order. */
const reversed = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value).reverse();
  return Object.fromEntries(entries.map(([key, item]) => [key, reversed(item)]));
};

describe('canonicalJson properties', () => {
  test('key insertion order never changes the key', () => {
    property(gen.json(), (value) => {
      expect(canonicalJson(reversed(value))).toBe(canonicalJson(value));
    });
  });

  test('two values share a key only when they are equal', () => {
    property(
      gen.tuple(gen.json(2), gen.json(2)),
      ([a, b]) => {
        expect(canonicalJson(a) === canonicalJson(b)).toBe(Bun.deepEquals(a, b, true));
      },
      { runs: 400 },
    );
  });

  test('over plain JSON the key parses back to the value', () => {
    property(gen.json(), (value) => {
      expect(JSON.parse(canonicalJson(value))).toEqual(value);
    });
  });
});
