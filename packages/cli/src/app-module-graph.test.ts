// The module scan's two rules an affected run leans on: a type-only import is an edge (a type
// change breaks the test that imports it), and a computed `import()` makes its file opaque.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; the scratch app must be a fresh directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the scratch app lives under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { fileImports, moduleFiles, selectTests } from './app-module-graph';

const root = await mkdtemp(join(tmpdir(), 'x-module-graph-'));
afterAll(() => rm(root, { recursive: true, force: true }));
await Bun.write(
  join(root, 'apps/web/app/a/types.ts'),
  'export interface A { readonly id: string }\n',
);
await Bun.write(join(root, 'apps/web/app/a/b.ts'), 'export const B = 1;\n');

describe('unit · fileImports', () => {
  test('a type-only import is an edge, inline `type` specifiers included', () => {
    const typed = fileImports(root, 'apps/web/app/a/x.ts', "import type { A } from './types';\n");
    expect(typed).toEqual({ imports: ['apps/web/app/a/types.ts'], opaque: false });
    const inline = fileImports(root, 'apps/web/app/a/y.ts', "import { type A } from './types';\n");
    expect(inline.imports).toEqual(['apps/web/app/a/types.ts']);
  });

  test('a computed import() is opaque; a literal one is an edge', () => {
    const computed = fileImports(
      root,
      'apps/web/app/a/z.ts',
      'const n = "./b";\nawait import(n);\n',
    );
    expect(computed.opaque).toBe(true);
    const literal = fileImports(root, 'apps/web/app/a/w.ts', "await import('./b');\n");
    expect(literal).toEqual({ imports: ['apps/web/app/a/b.ts'], opaque: false });
  });

  test('a package outside the app is no edge', () => {
    expect(
      fileImports(root, 'apps/web/app/a/v.ts', "import { t } from 'bun:test';\n").imports,
    ).toEqual([]);
  });
});

describe('unit · selectTests', () => {
  test('a changed file no import speaks for runs every test; a doc runs none', async () => {
    await Bun.write(join(root, 'apps/web/app/a/b.test.ts'), "import { B } from './b';\nvoid B;\n");
    await Bun.write(join(root, 'apps/web/app/a/c.test.ts'), 'export {};\n');
    const files = await moduleFiles(root);
    expect(selectTests(files, ['apps/web/app/a/b.ts']).tests).toEqual(['apps/web/app/a/b.test.ts']);
    const config = selectTests(files, ['app.config.ts']);
    expect(config.all).toBe(true);
    expect(config.tests).toHaveLength(2);
    expect(selectTests(files, ['README.md']).tests).toEqual([]);
    expect(selectTests(files, ['../packages/core/src/index.ts']).all).toBe(true);
  });
});
