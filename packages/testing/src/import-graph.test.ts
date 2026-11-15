// The closure the guard narrows by: static and literal dynamic imports followed, `import type`
// erased, a shebang tolerated, an unreadable module marking the graph incomplete.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no primitive that makes a uniquely named temp directory or removes one recursively.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { importGraphReader } from './import-graph';

const dir = await mkdtemp(join(tmpdir(), 'x-import-graph-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

const files: Readonly<Record<string, string>> = {
  'entry.ts': "import { a } from './a';\nimport type { T } from './typed';\nexport const e = a;\n",
  'a.ts':
    "#!/usr/bin/env bun\nexport { b as a } from './b';\nconst later = () => import('./lazy');\n",
  'b.ts': "import './data.json';\nexport const b = 1;\n",
  'lazy.ts': 'export const lazy = 1;\n',
  'typed.ts': 'export type T = number;\n',
  'data.json': '{}\n',
  'broken.ts': "import { b } from './b';\nexport const = ;\n",
};
for (const [name, source] of Object.entries(files)) await Bun.write(join(dir, name), source);

describe('importGraphReader', () => {
  test('follows static, re-export and literal dynamic imports; erases import type', async () => {
    const graph = await importGraphReader()(join(dir, 'entry.ts'));
    expect(graph.complete).toBe(true);
    expect([...graph.modules].map((path) => path.slice(dir.length + 1)).sort()).toEqual([
      'a.ts',
      'b.ts',
      'data.json',
      'entry.ts',
      'lazy.ts',
    ]);
  });

  test('a module that cannot be scanned makes the graph incomplete', async () => {
    expect((await importGraphReader()(join(dir, 'broken.ts'))).complete).toBe(false);
    expect((await importGraphReader()(join(dir, 'missing.ts'))).complete).toBe(false);
  });
});
