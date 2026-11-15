// What a symbol's text carries beyond its own declaration: the local types it names, and — on an
// `inherits` line the hash never reads — each interface its `extends` clause names, followed
// through imports, so a member re-declared from a parent is judged against the parent.

import { describe, expect, test } from 'bun:test';
import { symbolsOf } from './public-api-surface';
import { symbolReader } from './public-api-symbols';

const tree = (files: Record<string, string>) => ({
  files: new Map(Object.entries(files)),
  specifiers: new Map([['@a/b', 'index.d.ts']]),
});

describe('public-api-symbols · inherited members', () => {
  const files = {
    'index.d.ts': [
      "import type { Arm } from './arm';",
      'export interface Target extends Arm { readonly browser: B; }',
    ].join('\n'),
    'arm.d.ts': [
      "import type { Dial } from './dial';",
      'export interface Arm extends Dial { readonly page: P; }',
    ].join('\n'),
    'dial.d.ts': 'export interface Dial { readonly proxy?: string; }',
  };

  test('each ancestor, through imports, is an `inherits` line after the declaration', () => {
    const text = symbolReader(tree(files))('index.d.ts')['Target'] ?? '';
    expect(text.split('\n')).toEqual([
      'interface Target extends Arm { readonly browser : B ; }',
      'inherits interface Arm extends Dial { readonly page : P ; }',
      'inherits interface Dial { readonly proxy ? : string ; }',
    ]);
  });

  test('an `inherits` line never moves the hash: a parent is judged as its own symbol', () => {
    const text = symbolReader(tree(files))('index.d.ts')['Target'] ?? '';
    const own = text.split('\n')[0] ?? '';
    expect(symbolsOf({ x: text })['x']?.hash).toBe(symbolsOf({ x: own })['x']?.hash);
  });
});
