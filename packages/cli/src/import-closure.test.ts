// "Browser-reachable", followed NAME BY NAME through a barrel: a package barrel re-exports its
// whole surface, so a module-by-module closure reaches every server file of every package an
// island touches. These fixtures are the difference between a useful answer and "everything".

import { describe, expect, test } from 'bun:test';
import type { ClosureHost } from './import-closure';
import { importClosure, parseModule, resolveSpec } from './import-closure';

const hostOf = (
  files: Record<string, string>,
  aliases: Record<string, string> = {},
): ClosureHost => ({
  read: (path) => files[path],
  alias: (spec) => aliases[spec],
});

const BARREL = {
  'pkg/index.ts':
    "import './errors';\nexport { rpc } from './client';\nexport { toRoute as route } from './http';\n",
  'pkg/errors.ts': 'export const E = 1;\n',
  'pkg/client.ts': "import { send } from './send';\nexport const rpc = send;\n",
  'pkg/send.ts': 'export const send = 1;\n',
  'pkg/http.ts': 'export const toRoute = 2;\n',
};

describe('the import closure', () => {
  test('a named import reaches the module the name lives in, and not its siblings', () => {
    const host = hostOf(
      { ...BARREL, 'app/a.island.tsx': "import { rpc } from '@x/pkg';\n" },
      { '@x/pkg': 'pkg/index.ts' },
    );
    // The barrel's own side-effect import runs; `http.ts` holds a name nobody asked for.
    expect(importClosure(host, ['app/a.island.tsx'])).toEqual([
      'app/a.island.tsx',
      'pkg/client.ts',
      'pkg/errors.ts',
      'pkg/send.ts',
    ]);
  });

  test('a renamed re-export is followed under the name its source declares', () => {
    const host = hostOf(
      { ...BARREL, 'app/b.island.tsx': "import { route } from '@x/pkg';\n" },
      { '@x/pkg': 'pkg/index.ts' },
    );
    expect(importClosure(host, ['app/b.island.tsx'])).toContain('pkg/http.ts');
  });

  test('a namespace import and a dynamic import reach the whole module', () => {
    const host = hostOf(
      {
        ...BARREL,
        'app/c.island.tsx': "import * as all from '@x/pkg';\nconst m = await import('./late');\n",
        'app/late.ts': 'export const late = 1;\n',
      },
      { '@x/pkg': 'pkg/index.ts' },
    );
    const reached = importClosure(host, ['app/c.island.tsx']);
    expect(reached).toContain('pkg/http.ts');
    expect(reached).toContain('app/late.ts');
  });

  test('`export *` is searched for a name the barrel does not name itself', () => {
    const host = hostOf({
      'app/d.island.tsx': "import { deep } from './barrel';\n",
      'app/barrel.ts': "export * from './deep';\n",
      'app/deep.ts': 'export const deep = 1;\n',
    });
    expect(importClosure(host, ['app/d.island.tsx'])).toContain('app/deep.ts');
  });

  test('`import type` — and a clause of only `type` members — runs nothing, so reaches nothing', () => {
    const host = hostOf({
      'app/e.island.tsx':
        "import type { S } from './server-only';\nimport { type T } from './server-only';\n",
      'app/server-only.ts': 'export const s = 1;\n',
    });
    expect(importClosure(host, ['app/e.island.tsx'])).toEqual(['app/e.island.tsx']);
  });

  test('a specifier the host cannot resolve ENDS the walk there — the package boundary', () => {
    const host = hostOf({
      'app/f.island.tsx': "import { clientTransport } from '@ultimat3/core';\n",
    });
    expect(importClosure(host, ['app/f.island.tsx'])).toEqual(['app/f.island.tsx']);
  });

  test('an entry that does not exist is skipped, never thrown on', () => {
    expect(importClosure(hostOf({}), ['gone.island.tsx'])).toEqual([]);
  });
});

describe('reading one module', () => {
  test('a default import binds `default`; a side-effect import is an effect, not a binding', () => {
    const shape = parseModule("import React, { useState } from 'react';\nimport './global';\n");
    expect(shape.imports).toEqual([{ spec: 'react', names: new Set(['useState', 'default']) }]);
    expect(shape.effects).toContain('./global');
  });

  test('a commented-out import is not an import', () => {
    expect(parseModule("// import { x } from './gone';\n").imports).toEqual([]);
  });
});

describe('resolving a specifier', () => {
  const host = hostOf({ 'a/b/c.ts': '', 'a/d/index.tsx': '', 'a/e.ts': '' });

  test('relative, extension-less, through an index file and up a directory', () => {
    expect(resolveSpec(host, 'a/b/x.ts', './c')).toBe('a/b/c.ts');
    expect(resolveSpec(host, 'a/b/x.ts', '../d')).toBe('a/d/index.tsx');
    expect(resolveSpec(host, 'a/b/x.ts', '../e.js')).toBe('a/e.ts');
    expect(resolveSpec(host, 'a/b/x.ts', './nope')).toBeUndefined();
  });
});
