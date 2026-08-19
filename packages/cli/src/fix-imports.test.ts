// The resolver's fixtures are real files, because the thing under test is opening one: `node:fs`
// builds an isolated tree per test and removes it, so two runs cannot share a module cache or a
// stale `errors.ts` — the four bad `fix:` lines this closes lived in a file that imported its
// builder, and a fixture in memory would prove nothing about resolving the specifier.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidatePaths, createHelperResolver, scanImports } from './fix-imports';

describe('scanImports', () => {
  test('reads a named import and its specifier', () => {
    expect(scanImports("import { a, b } from './errors';")).toEqual([
      {
        specifier: './errors',
        names: [
          { exported: 'a', local: 'a' },
          { exported: 'b', local: 'b' },
        ],
      },
    ]);
  });

  test('an alias is the name the CALLER uses, and the declaration keeps its own', () => {
    expect(scanImports("import { dbNotImplemented as unsupported } from './errors';")).toEqual([
      {
        specifier: './errors',
        names: [{ exported: 'dbNotImplemented', local: 'unsupported' }],
      },
    ]);
  });

  // A type has no call site, so reading one could only produce a helper nothing calls.
  test('a type-only import, in either spelling, carries no value', () => {
    expect(scanImports("import type { FixSite } from './ts-scan';")).toEqual([]);
    expect(scanImports("import { type FixSite, scanFixes } from './ts-scan';")).toEqual([
      { specifier: './ts-scan', names: [{ exported: 'scanFixes', local: 'scanFixes' }] },
    ]);
  });

  // `errors.raise(…)` is a member access, which `helperFixSites` refuses by design — matching the
  // namespace here would hand it a name it can never resolve a call for.
  test('a namespace import is not a named one', () => {
    expect(scanImports("import * as errors from './errors';")).toEqual([]);
  });

  // `packages/cli/src/templates/` emits app source, imports included, inside template literals.
  // Read as declarations they pointed the resolver at modules that exist only in a generated app.
  test('an import written inside a comment or a template is not one', () => {
    expect(scanImports("// import { raise } from './errors';\n")).toEqual([]);
    expect(scanImports("const doc = `\nimport { raise } from './errors';\n`;")).toEqual([]);
  });
});

describe('candidatePaths', () => {
  test('a relative specifier resolves against the importing file, extension first', () => {
    expect(candidatePaths('packages/ui/src/icons/build-icons.ts', '../errors')).toEqual([
      'packages/ui/src/errors.ts',
      'packages/ui/src/errors.tsx',
      'packages/ui/src/errors/index.ts',
      'packages/ui/src/errors/index.tsx',
    ]);
  });

  // A package specifier is another package's file set: resolving one means guessing which of 29
  // packages a bare name came from, and a wrong guess reads an unrelated function's argument as
  // a fix. Measured 2026-08: 3 call sites in this repo import a fix builder this way.
  test('a package or node specifier resolves to nothing', () => {
    expect(candidatePaths('packages/cli/src/a.ts', '@ultimat3/db')).toEqual([]);
    expect(candidatePaths('packages/cli/src/a.ts', 'node:path')).toEqual([]);
  });

  test('a specifier that climbs out of the repo root names no file this may open', () => {
    expect(candidatePaths('packages/cli/src/a.ts', '../../../../secrets')).toEqual([]);
  });
});

describe('createHelperResolver', () => {
  let root = '';

  const write = async (path: string, text: string): Promise<void> => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fix-imports-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const ERRORS =
    'export function raise(cause: string, fix: string) {\n' +
    "  return new E({ code: 'X_A', cause, fix });\n" +
    '}\n' +
    'export const shout = (fix: string) => new E({ code: "X_B", fix });\n';

  test('a helper in a sibling module is callable here, at its declared position', async () => {
    await write('packages/ui/src/errors.ts', ERRORS);
    const resolve = createHelperResolver(root);
    const found = await resolve(
      'packages/ui/src/icons/build-icons.ts',
      "import { raise, shout } from '../errors';",
    );
    expect(found).toEqual([
      { name: 'raise', index: 1 },
      { name: 'shout', index: 0 },
    ]);
  });

  test('an alias renames the helper to what the call site writes', async () => {
    await write('packages/ui/src/errors.ts', ERRORS);
    const resolve = createHelperResolver(root);
    const found = await resolve('packages/ui/src/a.ts', "import { raise as bad } from './errors';");
    expect(found).toEqual([{ name: 'bad', index: 1 }]);
  });

  test('a directory specifier resolves through its index', async () => {
    await write('packages/ui/src/errors/index.ts', ERRORS);
    const resolve = createHelperResolver(root);
    const found = await resolve('packages/ui/src/a.ts', "import { raise } from './errors';");
    expect(found).toEqual([{ name: 'raise', index: 1 }]);
  });

  test('a name the module declares but does not build an error with is not a helper', async () => {
    await write('packages/ui/src/errors.ts', 'export const label = (fix: string) => fix.trim();\n');
    const resolve = createHelperResolver(root);
    const found = await resolve('packages/ui/src/a.ts', "import { label } from './errors';");
    expect(found).toEqual([]);
  });

  // The named limit: another PACKAGE's file set is not resolved, and a relative path that is not
  // there resolves to nothing rather than to a guess. What the gate reports about the fixes those
  // hide is `FixScan.unreadable`, counted at the call site.
  test('a package specifier and a missing file both resolve to no helper', async () => {
    const resolve = createHelperResolver(root);
    const found = await resolve(
      'packages/ui/src/a.ts',
      "import { UltimateError } from '@ultimat3/core';\nimport { gone } from './missing';",
    );
    expect(found).toEqual([]);
  });
});
