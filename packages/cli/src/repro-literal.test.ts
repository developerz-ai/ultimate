// A captured value written as source must read back as itself: quotes, backslashes, line breaks
// and keys that are not identifiers included — a bundle is user input, and the file is code.

import { expect, test } from 'bun:test';
import { tsLiteral } from './repro-literal';

const readBack = (source: string): unknown => new Function(`return ${source};`)();

test('a hostile value round-trips through the literal', () => {
  const value = {
    plain: 'x',
    quote: "it's \\ here",
    lines: 'a\nb\r c',
    'not-an-id': [1, null, true, { nested: [] }],
    __proto__x: {},
  };
  expect(readBack(tsLiteral(value))).toEqual(value);
});

test('a key named __proto__ stays a key', () => {
  const value = JSON.parse('{"__proto__": {"polluted": true}}');
  const back = readBack(tsLiteral(value)) as Record<string, unknown>;
  expect(Object.keys(back)).toEqual(['__proto__']);
  expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
});
