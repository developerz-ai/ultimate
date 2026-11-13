// The `.d.ts` reader `scripts/public-api.ts` hashes through: the statement shapes `tsc` emits, and
// the spellings that must never change a hash (comments, CRLF, quotes, private members).

import { describe, expect, test } from 'bun:test';
import { parseDts, splitStatements, tokenize } from './public-api-dts';

const textOf = (source: string, name: string): string =>
  parseDts(source)
    .declarations.filter((one) => one.name === name)
    .map((one) => one.text)
    .join('\n');

describe('public-api-dts · statements', () => {
  test('a class whose heritage clause holds an object type ends at its own body', () => {
    const source = [
      'export declare class Box extends Base<{ a: 1 }> { readonly x: number; }',
      'export declare const after: number;',
    ].join('\n');
    expect(splitStatements(tokenize(source))).toHaveLength(2);
    expect(parseDts(source).declarations.map((one) => one.name)).toEqual(['Box', 'after']);
  });

  test('a const enum, a namespace and a module augmentation are one statement each', () => {
    const source = [
      'export declare const enum Tone { Low = 0, High = 1 }',
      'export declare namespace Space { const a: 1; }',
      "declare module 'x' { interface Y { z: 1 } }",
      'export type After = 1;',
    ].join('\n');
    expect(parseDts(source).declarations.map((one) => one.name)).toEqual([
      'Tone',
      'Space',
      'After',
    ]);
  });

  test('a variable statement with two declarators declares two names', () => {
    const decls = parseDts(
      'export declare const a: Map<string, number>, b: () => void;',
    ).declarations;
    expect(decls.map((one) => [one.name, one.text])).toEqual([
      ['a', 'const a : Map < string , number >'],
      ['b', 'const b : ( ) => void'],
    ]);
  });

  test('re-exports, lists, stars and imports are told apart', () => {
    const module = parseDts(
      [
        "import { type A, B as C } from './a';",
        "import * as ns from './n';",
        "export { x, type y as z } from './x';",
        'export { C as D };',
        "export * from './all';",
        "export * as group from './group';",
        'export {};',
      ].join('\n'),
    );
    expect(module.imports).toEqual([
      { local: 'A', imported: 'A', from: './a' },
      { local: 'C', imported: 'B', from: './a' },
      { local: 'ns', imported: '*', from: './n' },
    ]);
    expect(module.reexports).toEqual([
      { local: 'x', name: 'x', from: './x' },
      { local: 'y', name: 'z', from: './x' },
    ]);
    expect(module.lists).toEqual([{ local: 'C', name: 'D' }]);
    expect(module.stars).toEqual([{ from: './all' }, { from: './group', as: 'group' }]);
  });
});

describe('public-api-dts · what never changes a hash', () => {
  test('comments, CRLF, indentation and `export`/`declare` are not part of the text', () => {
    const lf = '/** Doc. */\nexport declare function f(a: string): void;\n';
    const crlf = '// other\r\ndeclare   function f(\r\n  a: string\r\n): void;\r\n';
    expect(textOf(crlf, 'f')).toBe(textOf(lf, 'f'));
    expect(textOf(lf, 'f')).toBe('function f ( a : string ) : void');
  });

  test('a quote style is not part of a string type: \'a\' and "a" read alike', () => {
    expect(textOf("export type T = 'a' | 'b';", 'T')).toBe(
      textOf('export type T = "a" | "b";', 'T'),
    );
  });

  test('an import("…") qualifier — the emitter spelling a path — is dropped', () => {
    expect(textOf('export declare const a: import("../x/y").Thing;', 'a')).toBe('const a : Thing');
  });

  test('untyped private members are dropped; a public member is kept', () => {
    const before = 'export declare class K { #private; private cache; private static n?; m(): 1; }';
    expect(textOf(before, 'K')).toBe('class K { m ( ) : 1 ; }');
  });

  test('a template literal type is one token, its nested placeholders included', () => {
    // Joined on `$` so no placeholder is spelt inside a plain string literal.
    const literal = ['`a-', '{`b', '{string}`}`'].join('$');
    expect(tokenize(`type T = ${literal};`)).toEqual(['type', 'T', '=', literal, ';']);
  });
});
