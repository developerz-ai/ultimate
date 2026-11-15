// What a declaration's shape holds: members keyed by name (quotes, modifiers and accessors read
// through), signatures with no name as opaque keys, parameter unions as sets, literal sets, values
// and classes — and for anything else its own text plus the shapes of the locals it names.

import { describe, expect, test } from 'bun:test';
import { shapeOf } from './public-api-shape';

const membersOf = (text: string): Readonly<Record<string, string>> => {
  const shape = shapeOf(text);
  if (shape.kind !== 'members') return expect.unreachable(`${text} must have members`);
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

describe('public-api-shape · every declaration has a shape', () => {
  test('a literal union, `keyof typeof` a local object and a literal tuple are literal sets', () => {
    for (const text of [
      'type Mode = "a" | "b" | - 1',
      'type Code = keyof typeof T\nlocal const T : { readonly A : "x" ; readonly B : "y" ; }',
      'const NAMES : readonly [ "a" , "b" ]',
    ]) {
      expect(shapeOf(text).kind).toBe('literals');
    }
    const one = shapeOf('type Mode = "a" | "b"');
    expect(one).toEqual(shapeOf('type Mode = "b" | "a"'));
  });

  test('a const typed as an object is a value; a class keeps members and its constructor', () => {
    expect(shapeOf('const S : { readonly A : 1 ; }').kind).toBe('value');
    const shape = shapeOf(
      'class E extends B { static readonly code = "X" ; private secret ; readonly at : number ; constructor ( init : { a : 1 ; b ? : 2 ; } ) ; }',
    );
    if (shape.kind !== 'class') return expect.unreachable('a class has a class shape');
    expect(Object.keys(shape.members).sort()).toEqual(['at', 'static code']);
    expect(shape.ctor?.[0]?.startsWith('{a=')).toBe(true);
  });

  test('a type alias ending in `& { … }` is members', () => {
    expect(shapeOf('type O = RequestInit & { readonly a ? : 1 ; }').kind).toBe('members');
    expect(shapeOf('type O = A & { a : 1 ; } | B').kind).toBe('declaration');
  });

  test('anything else is a declaration, keyed by its first word, with its locals shaped', () => {
    expect(shapeOf('enum E { A = 0 }')).toMatchObject({ kind: 'declaration', keyword: 'enum' });
    expect(shapeOf('const KIND : "sub"')).toMatchObject({ kind: 'declaration', keyword: 'const' });
    expect(shapeOf('external ./x Y')).toMatchObject({ keyword: 'external' });
    expect(shapeOf('function f ( a : 1 ) : void\nfunction f ( a : 2 ) : void').kind).toBe(
      'overloads',
    );
    expect(shapeOf('const a : 1\nconst a : 2')).toMatchObject({ keyword: 'overloaded const' });
    const spec = shapeOf(
      'type S = F & ( { a : 1 ; } | { b : 1 ; } )\nlocal interface F { c : 1 ; }',
    );
    if (spec.kind !== 'declaration') return expect.unreachable('an intersection is a declaration');
    expect(spec.locals?.['F']?.shape?.kind).toBe('members');
  });

  test('local lines after the declaration still leave it a shape', () => {
    expect(shapeOf('function f ( o : O ) : void\nlocal interface O { a : 1 ; }')?.kind).toBe(
      'function',
    );
  });
});
