// Pins the type-position half of the one import scanner: Bun's transpiler drops `typeof import(…)`
// and `import(…).T`, so a tier-crossing edge spelled only in a type would pass `boundaries` unseen
// unless this masked read finds it — and finding a quoted or commented one would fail clean code.

import { describe, expect, test } from 'bun:test';
import { maskLiterals } from '@ultimat3/core';
import { scanAllImports, typePositionImports } from './import-scan';

const scan = (source: string): readonly string[] =>
  typePositionImports(source, maskLiterals(source));

describe('unit · import-scan', () => {
  test('a type-position import(…) is read: typeof, an annotation, a return type', () => {
    expect(
      scan(
        "type A = typeof import('@ultimat3/cli');\n" +
          'let b: import("@ultimat3/admin").B;\n' +
          "function c(): import( '@ultimat3/mcp' ).C { return null as never; }",
      ),
    ).toEqual(['@ultimat3/cli', '@ultimat3/admin', '@ultimat3/mcp']);
  });

  test('a string, a template, a comment or a member named import is not an import', () => {
    expect(
      scan(
        "// typeof import('@ultimat3/a')\n" +
          "/* import('@ultimat3/b') */\n" +
          'const c = "typeof import(\'@ultimat3/c\')";\n' +
          "const d = `let x: import('@ultimat3/d').D;`;\n" +
          "const e = loader.import('@ultimat3/e');\n" +
          'const f = import(name);',
      ),
    ).toEqual([]);
  });

  test('scanAllImports reads them when handed the mask, and the transpiler alone does not', () => {
    const source = "import { x } from 'a';\nexport type Cli = typeof import('@ultimat3/cli');";
    expect(scanAllImports({ path: 'f.ts', source })).toEqual(['a']);
    expect(scanAllImports({ path: 'f.ts', source }, maskLiterals(source))).toEqual([
      'a',
      '@ultimat3/cli',
    ]);
  });
});
