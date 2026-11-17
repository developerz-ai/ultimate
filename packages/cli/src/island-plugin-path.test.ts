// A file a plugin hands `Bun.build` loads whatever its path spells: a `..` anywhere in it — a
// directory NAME, which no normalize folds — is served through a re-export, and every other path
// is answered as itself, so a build that never meets one keeps its bytes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete or temp directory API.
import { mkdtemp, rm } from 'node:fs/promises';
// why: `node:os` — the temp directory's location; Bun exposes none.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import { fileResult, serveRefusedPaths } from './island-plugin-path';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ultimate-plugin-path-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A minified build whose one import, `target`, a plugin answers with `file`. */
async function bundled(file: string): Promise<string> {
  const built = await Bun.build({
    entrypoints: ['virtual:entry'],
    minify: true,
    plugins: [
      {
        name: 'probe',
        setup(build) {
          build.onResolve({ filter: /^virtual:entry$/ }, () => ({ path: 'entry', namespace: 'v' }));
          build.onLoad({ filter: /^entry$/, namespace: 'v' }, () => ({
            contents: "import { v } from 'target';\nconsole.log(v);\n",
            loader: 'js',
          }));
          build.onResolve({ filter: /^target$/ }, () => fileResult(file));
          serveRefusedPaths(build);
        },
      },
    ],
  });
  const [output] = built.outputs;
  return (await output?.text()) ?? '';
}

describe('fileResult', () => {
  test('a path is answered as itself unless it holds `..`', () => {
    expect(fileResult('/app/node_modules/x/m.js')).toEqual({ path: '/app/node_modules/x/m.js' });
    expect(fileResult('/app/.bun/x@file+..+y/m.js').namespace).toBeDefined();
  });

  for (const dir of ['a+..+b', 'b..c', 'd..']) {
    test(`a file under \`${dir}\` bundles, the same bytes as under a plain directory`, async () => {
      await Bun.write(join(root, dir, 'm.js'), 'export const v = 1;\n');
      await Bun.write(join(root, 'plain', 'm.js'), 'export const v = 1;\n');

      const refused = await bundled(join(root, dir, 'm.js'));

      expect(refused).toContain('console.log');
      expect(refused).toBe(await bundled(join(root, 'plain', 'm.js')));
    });
  }
});
