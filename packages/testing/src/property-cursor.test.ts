// Property: a keyset cursor round-trips any page position — multibyte scopes, ids and key values
// included — and is refused, never misread, under another scope or with one character changed.

import { describe, expect, test } from 'bun:test';
import { decodeCursor, encodeCursor, isUltimateError } from '@ultimat3/core';
import { property } from './property';
import { gen } from './property-gen';

const keyValue = gen.union<unknown>([
  gen.constant(null),
  gen.oneOf([false, true]),
  gen.int(-(2 ** 53) + 1, 2 ** 53 - 1),
  gen.string({ maxLength: 12 }),
]);

const position = gen.map(
  gen.tuple(
    gen.string({ maxLength: 24 }),
    gen.string({ maxLength: 12 }),
    gen.array(keyValue, { maxLength: 4 }),
  ),
  ([scope, id, key]) => ({ scope, id, key }),
);

const refused = (fn: () => unknown): boolean => {
  try {
    fn();
  } catch (error) {
    return isUltimateError(error) && error.code === 'X_CURSOR_INVALID';
  }
  return false;
};

describe('cursor codec properties', () => {
  test('decode(encode(position), scope) is the position', () => {
    property(position, (payload) => {
      expect(decodeCursor(encodeCursor(payload), payload.scope)).toEqual(payload);
    });
  });

  test('another scope is refused as X_CURSOR_INVALID', () => {
    property(gen.tuple(position, gen.string({ minLength: 1, maxLength: 6 })), ([payload, extra]) =>
      refused(() => decodeCursor(encodeCursor(payload), payload.scope + extra)),
    );
  });

  test('one changed character is refused, never a different page', () => {
    property(gen.tuple(position, gen.int(0, 10_000)), ([payload, at]) => {
      const cursor = encodeCursor(payload);
      const index = at % cursor.length;
      const swapped = cursor[index] === 'A' ? 'B' : 'A';
      return refused(() =>
        decodeCursor(cursor.slice(0, index) + swapped + cursor.slice(index + 1), payload.scope),
      );
    });
  });
});
