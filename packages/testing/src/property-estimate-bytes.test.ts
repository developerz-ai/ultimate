// Property: `estimateBytes` — what the LRU's byte budget is charged — is the UTF-8 size of what is
// stored, counts a Map or a Set by its entries rather than as `{}`, and never shrinks as a value grows.

import { describe, expect, test } from 'bun:test';
import { estimateBytes } from '@ultimat3/cache';
import { property } from './property';
import { gen } from './property-gen';

const utf8 = (text: string): number => new TextEncoder().encode(text).byteLength;

describe('estimateBytes properties', () => {
  test('a string is its UTF-8 length, a structure its serialised UTF-8 length', () => {
    property(gen.string({ maxLength: 40 }), (text) => estimateBytes(text) === utf8(text));
    // Wrapped: a top-level string is charged unquoted, by the line above.
    property(gen.json(), (value) => estimateBytes([value]) === utf8(JSON.stringify([value])));
  });

  test('a Map or a Set is charged for its entries, never as an empty object', () => {
    const entries = gen.array(gen.tuple(gen.string({ maxLength: 6 }), gen.json(1)), {
      maxLength: 6,
    });
    property(entries, (list) => {
      const map = new Map(list);
      expect(estimateBytes(map)).toBe(estimateBytes([...map.entries()]));
      expect(estimateBytes(new Set(list.map(([key]) => key)))).toBe(
        estimateBytes([...new Set(list.map(([key]) => key))]),
      );
    });
  });

  test('appending to a list never lowers its estimate', () => {
    property(
      gen.tuple(gen.array(gen.json(1), { maxLength: 6 }), gen.json(1)),
      ([list, more]) => estimateBytes([...list, more]) > estimateBytes(list),
    );
  });
});
