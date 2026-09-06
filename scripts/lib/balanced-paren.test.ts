// The one paren walker, on the inputs each of its three callers derailed it with. It lived twice —
// `index-of-order.ts` skipped comments and strings, `sql-literal-copies.ts` skipped neither — and
// the weaker copy's blindness DROPPED sites: a `(` inside a literal moved the depth, `close` came
// back wrong or `-1`, and the rule read the file as clean.

import { describe, expect, test } from 'bun:test';
import { balancedClose, topLevelArguments } from './balanced-paren';

/** The index of the `(` that opens the call, so a case reads as the source it is about. */
const openOf = (src: string): number => src.indexOf('(');

const inner = (src: string): string => src.slice(openOf(src) + 1, balancedClose(src, openOf(src)));

describe('balancedClose', () => {
  test('the matching paren, honouring nesting', () => {
    const src = 'f(g(1), 2) rest';
    expect(balancedClose(src, 1)).toBe(src.indexOf(')', src.indexOf('2')));
    expect(inner(src)).toBe('g(1), 2');
  });

  test('a paren inside a STRING never moves the depth', () => {
    expect(inner(`f(new RegExp("(", 'g'), "''")`)).toBe(`new RegExp("(", 'g'), "''"`);
    expect(inner(`f(")", a)`)).toBe(`")", a`);
  });

  test('nor one inside a template or a comment', () => {
    expect(inner('f(`a ) b`, c)')).toBe('`a ) b`, c');
    expect(inner('f(a, /* ) */ b)')).toBe('a, /* ) */ b');
    expect(inner('f(a,\n  // ) not a paren\n  b)')).toBe('a,\n  // ) not a paren\n  b');
  });

  // The half a string-only walker gets wrong the other way: `/'/g` opens a REGEX, and reading its
  // quote as a string run swallowed the rest of the call. `a / b` is division and opens nothing,
  // which is why the decision is made on what sits in front of the slash.
  test('a regex literal is a run, and a division is not', () => {
    expect(inner(`f(value.replace(/'/g, "''"))`)).toBe(`value.replace(/'/g, "''")`);
    expect(inner('f(/[a-z/)]/.test(x), y)')).toBe('/[a-z/)]/.test(x), y');
    expect(inner('f(total / count, y)')).toBe('total / count, y');
  });

  test('an unbalanced source answers -1 rather than the end of the file', () => {
    expect(balancedClose('f(a, b', 1)).toBe(-1);
    expect(balancedClose("f(a, 'unterminated", 1)).toBe(-1);
  });
});

describe('topLevelArguments', () => {
  test('splits on top-level commas only', () => {
    expect(topLevelArguments('a, f(b, c), [d, e]')).toEqual(['a', 'f(b, c)', '[d, e]']);
  });

  test('a comma inside a string, a template or a regex is not a separator', () => {
    expect(topLevelArguments(`"a,b", c`)).toEqual([`"a,b"`, 'c']);
    expect(topLevelArguments('`a,b`, c')).toEqual(['`a,b`', 'c']);
    expect(topLevelArguments('/a,b/g, c')).toEqual(['/a,b/g', 'c']);
  });

  test('one argument comes back whole', () => {
    expect(topLevelArguments(`new RegExp("'", 'g')`)).toEqual([`new RegExp("'", 'g')`]);
  });
});
