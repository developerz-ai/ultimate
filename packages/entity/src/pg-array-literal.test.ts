// The Postgres array literal grammar: what is refused first, then what is read. The texts are the
// ones a server prints (`select array[...]::text`), so each case is a claim Postgres made and this
// reader has to agree with — the live half is `column-matrix.live.test.ts`.

import { describe, expect, test } from 'bun:test';
import { parsePgArray } from './pg-array-literal';
import { arrayLiteral } from './pg-row';

const raw = (text: string) => parsePgArray(text, (element) => element);

describe('parsePgArray · a text that is not an array literal is null, never a partial array', () => {
  test.each([
    ['an empty string', ''],
    ['a bare scalar', 'a'],
    ['a uuid on its own', '01a12719-28e5-735e-b5bb-000000000000'],
    ['an unclosed brace', '{a,b'],
    ['an unopened brace', 'a,b}'],
    ['a quote that never closes', '{"a,b}'],
    ['a backslash at the very end', '{"a\\'],
    ['content after the closing brace', '{a}b'],
    ['a second array after the first', '{a}{b}'],
    ['a quote inside a bare element', '{a"b}'],
    ['a brace inside a bare element', '{a{b}'],
    ['text straight after a closing quote', '{"a"b}'],
    ['a dimension prefix', '[0:1]={a,b}'],
    ['a JSON array', '["a","b"]'],
    ['what Bun.SQL sends for a JS array', 'a,b'],
  ])('%s', (_name, text) => {
    expect(raw(text)).toBeNull();
  });
});

describe('parsePgArray · elements', () => {
  test('the empty array is an array of nothing, not of one empty string', () => {
    expect(raw('{}')).toEqual([]);
  });

  test('bare elements are split on commas and kept as written', () => {
    expect(raw('{a,b,c}')).toEqual(['a', 'b', 'c']);
    expect(raw('{01a12719-28e5-735e-b5bb-000000000000}')).toEqual([
      '01a12719-28e5-735e-b5bb-000000000000',
    ]);
  });

  test('a quoted element keeps its comma, its braces and its padding', () => {
    expect(raw('{"a,b","{c}"," d "}')).toEqual(['a,b', '{c}', ' d ']);
  });

  test('a backslash escapes exactly one character inside quotes', () => {
    expect(raw('{"q\\"x","b\\\\y"}')).toEqual(['q"x', 'b\\y']);
  });

  test('a quoted empty string is an element; an unquoted NULL is the null member', () => {
    expect(raw('{"",NULL,null,"NULL"}')).toEqual(['', null, null, 'NULL']);
  });

  test('the null member never reaches the element decoder', () => {
    const seen: string[] = [];
    parsePgArray('{1,NULL,3}', (element) => seen.push(element));
    expect(seen).toEqual(['1', '3']);
  });

  test('a line break and a tab inside quotes are data', () => {
    expect(raw('{"line\nbreak","tab\there"}')).toEqual(['line\nbreak', 'tab\there']);
  });

  test('a second dimension is a nested array', () => {
    expect(raw('{{a,b},{c,d}}')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  test('the decoder decides the element type', () => {
    expect(parsePgArray('{1,2}', Number)).toEqual([1, 2]);
  });
});

describe('parsePgArray · reads what arrayLiteral writes', () => {
  test.each([
    [[]],
    [['plain']],
    [['with,comma', 'quote"inside', 'back\\slash', '{braces}', '', ' padded ']],
    [['NULL', 'null', null]],
    [['line\nbreak', 'tab\there', 'ünï©ode ✓', "single'quote", '\\"', '"\\']],
    [[null, null]],
  ])('%j', (members) => {
    expect(raw(arrayLiteral(members))).toEqual(members);
  });
});
