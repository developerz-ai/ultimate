// One resolver, two graphs. The reload graph follows every file a module names; the document
// graph only what evaluating it evaluates — and an edge wrong in either direction is a save that
// does not reload, or a worker that leaves out a module registering something.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { resolvedImports } from './module-imports';

let dir = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'x-module-imports-'));
  for (const file of ['value.ts', 'shape.ts', 'erased.ts', 'lazy.ts', 'view.tsx']) {
    await Bun.write(join(dir, file), 'export const one = 1;\n');
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** `Shape` is imported WITHOUT `type` and used only as one: an edge at runtime, so both keep it. */
const SOURCE = `import { one } from './value';
import { Shape } from './shape';
import type { Erased } from './erased';
import { type Inline } from './erased';
import { missing } from './never-written';
export const view = async () => (await import('./view')).one + one;
export const lazy = () => import('./lazy');
export const shaped = (value: Shape): Erased & Inline => value as Erased & Inline;
`;

describe('unit · the files a module imports', () => {
  test('referenced is every file the module names, lazy ones included; a declared type import and an unresolvable specifier are no edge', () => {
    expect(resolvedImports(join(dir, 'a.ts'), SOURCE, 'referenced')).toEqual(
      ['value.ts', 'shape.ts', 'view.tsx', 'lazy.ts'].map((file) => join(dir, file)),
    );
  });

  test('evaluated is what importing the module evaluates: no await import() target', () => {
    expect(resolvedImports(join(dir, 'a.ts'), SOURCE, 'evaluated')).toEqual(
      ['value.ts', 'shape.ts'].map((file) => join(dir, file)),
    );
  });

  test('a .tsx file is read as one, and a file that will not parse imports nothing', () => {
    const jsx = "import { one } from './value';\nexport const A = () => <b>{one}</b>;\n";
    expect(resolvedImports(join(dir, 'a.tsx'), jsx, 'evaluated')).toEqual([join(dir, 'value.ts')]);
    expect(resolvedImports(join(dir, 'a.ts'), 'import { from "./value', 'referenced')).toEqual([]);
  });
});
