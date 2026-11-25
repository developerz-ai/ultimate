// The walk's own promises: what it reads, the order of a chain, and where a verdict ends it.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive remove; Bun reports real paths.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import type { WalkVerdict } from './evaluated-walk';
import { createEvaluatedGraph } from './evaluated-walk';

let root = '';
const at = (path: string): string => join(root, path);
const write = (path: string, text: string): Promise<number> => Bun.write(at(path), text);
const follow = (): WalkVerdict => 'follow';

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'x-evaluated-walk-')));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('a walk', () => {
  test('a chain is start first, each step with the specifier that reached it', async () => {
    await write('a.ts', "import './b';\n");
    await write('b.ts', "import './c';\n");
    await write('c.ts', "import './d';\n");
    await write('d.ts', 'export {};\n');
    const walk = await createEvaluatedGraph().walk([at('a.ts')], follow);
    expect(walk.chainTo(at('d.ts'))).toEqual([
      { path: at('a.ts') },
      { path: at('b.ts'), specifier: './b' },
      { path: at('c.ts'), specifier: './c' },
      { path: at('d.ts'), specifier: './d' },
    ]);
    expect(walk.chainTo(at('nowhere.ts'))).toEqual([]);
  });

  // The text says `import`: were it read as source, the walk would reach what no import names.
  test.each(['data.json', 'data.css', 'data.svg', 'data.txt', 'data.wasm'])(
    '%s is a target, and never read as source',
    async (name) => {
      await write('a.ts', `import data from './${name}';\nimport './b';\nexport { data };\n`);
      await write('b.ts', 'export {};\n');
      await write(name, "import './hidden';\n");
      await write('hidden.ts', 'export {};\n');
      const read = spyOn(Bun, 'file');
      try {
        const walk = await createEvaluatedGraph().walk([at('a.ts')], follow);
        expect(read.mock.calls.map(([path]) => String(path))).toEqual([at('a.ts'), at('b.ts')]);
        expect(walk.chainTo(at(name)).length).toBe(2);
        expect(walk.chainTo(at('hidden.ts'))).toEqual([]);
      } finally {
        read.mockRestore();
      }
    },
  );

  test.each(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'])(
    'a .%s module is source',
    async (extension) => {
      await write('a.ts', `import './m.${extension}';\n`);
      await write(`m.${extension}`, "import './end';\n");
      await write('end.ts', 'export {};\n');
      const walk = await createEvaluatedGraph().walk([at('a.ts')], follow);
      expect(walk.chainTo(at('end.ts')).length).toBe(3);
    },
  );

  test('a module gone by the time it is read has no imports', async () => {
    const walk = await createEvaluatedGraph().walk([at('gone.ts')], follow);
    expect(walk.chainTo(at('gone.ts'))).toEqual([{ path: at('gone.ts') }]);
  });
});
