// What a declaration's shape holds: members keyed by name (quotes, modifiers and accessors read
// through), signatures with no name as opaque keys, parameter unions as sets — and no shape at all
// for a declaration this cannot read, so its change stays a break.

import { describe, expect, test } from 'bun:test';
import { shapeOf } from './public-api-shape';

const membersOf = (text: string): Readonly<Record<string, string>> => {
  const shape = shapeOf(text);
  if (shape?.kind !== 'members') return expect.unreachable(`${text} must have members`);
  return shape.members;
};

describe('public-api-shape · members', () => {
  test('a quoted identifier is its bare name; a property named like a modifier is itself', () => {
    const members = membersOf('interface A { "label" ? : string ; readonly : boolean ; }');
    expect(Object.keys(members).sort()).toEqual(['label', 'readonly']);
    expect(members['label']?.startsWith('?')).toBe(true);
    expect(members['readonly']?.startsWith('?')).toBe(false);
  });

  test('an accessor pair and method overloads are one member each', () => {
    const members = membersOf(
      'interface A { get size ( ) : number ; set size ( v : number ) ; on ( a : 1 ) : void ; on ( a : 2 ) : void ; }',
    );
    expect(Object.keys(members).sort()).toEqual(['on', 'size']);
  });

  test('an index or call signature is an opaque key', () => {
    const members = membersOf('interface A { [ key : string ] : number ; ( a : 1 ) : void ; }');
    expect(Object.keys(members).every((key) => key.startsWith('#'))).toBe(true);
    expect(Object.keys(members)).toHaveLength(2);
  });

  test('a generic interface whose constraint holds braces ends at its own body', () => {
    expect(Object.keys(membersOf('interface A < T extends { a : 1 ; } > { b : T ; }'))).toEqual([
      'b',
    ]);
  });
});

describe('public-api-shape · functions', () => {
  test('a parameter union is a set: reordered, the same code', () => {
    const one = shapeOf('function f ( m : "a" | "b" ) : void');
    const two = shapeOf('function f ( m : "b" | "a" ) : void');
    expect(one).toEqual(two);
    expect(one?.kind === 'function' ? one.params[0]?.split('|') : []).toHaveLength(2);
  });

  test('rest and optional are read; the name is not', () => {
    const shape = shapeOf('function f ( a ? : number , ... more : string [ ] ) : void');
    if (shape?.kind !== 'function') return expect.unreachable('a function has a function shape');
    expect(shape.params[0]?.startsWith('?')).toBe(true);
    expect(shape.params[1]?.startsWith('...')).toBe(true);
    expect(shapeOf('function f ( b ? : number , ... rest : string [ ] ) : void')).toEqual(shape);
  });

  test('a conditional type in a parameter is one member, never split', () => {
    const shape = shapeOf('function f ( a : T extends U ? "x" | "y" : "z" ) : void');
    expect(shape?.kind === 'function' ? shape.params[0]?.includes('|') : true).toBe(false);
  });
});

describe('public-api-shape · none', () => {
  test('a class, an enum, a union alias, a value const and overloads have no shape', () => {
    for (const text of [
      'class A { x : 1 ; }',
      'enum E { A = 0 }',
      'type Mode = "a" | "b"',
      'const KIND : "sub"',
      'const f : ( ( a : 1 ) => void ) | null',
      'function f ( a : 1 ) : void\nfunction f ( a : 2 ) : void',
      'external ./x Y',
    ]) {
      expect(shapeOf(text)).toBeUndefined();
    }
  });

  test('local lines after the declaration still leave it a shape', () => {
    expect(shapeOf('function f ( o : O ) : void\nlocal interface O { a : 1 ; }')?.kind).toBe(
      'function',
    );
  });
});
