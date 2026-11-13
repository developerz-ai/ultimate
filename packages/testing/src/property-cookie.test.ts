// Property: a value `serializeSetCookie` wrote, `readCookie` reads back exactly from a header full
// of neighbours; and no `Cookie:` header a client can send makes `readCookie` throw.

import { describe, expect, test } from 'bun:test';
import { readCookie, serializeSetCookie } from '@ultimat3/core';
import { property } from './property';
import { gen } from './property-gen';

const TOKEN_CHARS = [
  'a',
  'Z',
  '0',
  '_',
  '-',
  '.',
  '!',
  '#',
  '$',
  '%',
  '&',
  "'",
  '*',
  '+',
  '^',
  '`',
  '|',
  '~',
] as const;
const name = gen.map(
  gen.string({ minLength: 1, maxLength: 10, chars: gen.oneOf(TOKEN_CHARS) }),
  (rest) => `n${rest}`,
);
const neighbour = gen.map(
  gen.tuple(
    gen.string({ minLength: 1, maxLength: 4, chars: gen.oneOf(['x', 'y']) }),
    gen.string({ maxLength: 8 }),
  ),
  ([key, value]) => `${key}=${encodeURIComponent(value)}`,
);

/** The `name=value` pair at the head of a `Set-Cookie` line: what the browser sends back. */
const pairOf = (setCookie: string): string => setCookie.slice(0, setCookie.indexOf(';'));

describe('cookie codec properties', () => {
  test('readCookie(serializeSetCookie(name, value)) is the value, among any neighbours', () => {
    property(
      gen.tuple(name, gen.string({ maxLength: 40 }), gen.array(neighbour, { maxLength: 3 })),
      ([key, value, around]) => {
        const header = [...around, pairOf(serializeSetCookie(key, value)), ...around].join('; ');
        expect(readCookie(header, key)).toBe(value);
      },
      { runs: 500 },
    );
  });

  test('no client header makes readCookie throw', () => {
    property(
      gen.tuple(gen.string({ maxLength: 60 }), name),
      ([header, key]) => {
        const read = readCookie(header, key);
        expect(read === null || typeof read === 'string').toBe(true);
      },
      { runs: 500 },
    );
  });
});
