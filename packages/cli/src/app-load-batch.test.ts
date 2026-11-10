// Two loads in one process never share a batch's files. `bun test --parallel` runs each file
// isolated in a long-lived worker: this module is evaluated afresh per file, Bun's module cache is
// not, and a batch directory named by a per-instance counter was written twice under one path —
// the second load imported the first load's hooks, which handed it the first app's modules.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no API for a temporary directory or a recursive delete.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';

let root = '';

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

const BATCH = JSON.stringify(join(import.meta.dir, 'app-load-batch.ts'));

/** A test file that imports its own three modules and asserts each hook handed back its own. */
const loader = (app: string): string => `import { expect, test } from 'bun:test';
import { importInOrder } from ${BATCH};
test('${app} gets its own modules', async () => {
  const dir = import.meta.dir + '/${app}';
  const files = ['1', '2', '3'].map((name) => dir + '/' + name + '.ts');
  const heard: string[] = [];
  const imported = await importInOrder(files, new Set(), (_index, module) => {
    heard.push(String(module.who));
  });
  expect(heard).toEqual(['${app}1', '${app}2', '${app}3']);
  expect(imported.map((one) => (one.ok ? one.module.who : 'failed'))).toEqual(heard);
});
`;

describe('unit · a batch is never written where an earlier load in the process wrote one', () => {
  test('two isolated files, one worker: each load hears its own modules', async () => {
    root = mkdtempSync(join(tmpdir(), 'x-load-batch-'));
    for (const app of ['a', 'b']) {
      for (const name of ['1', '2', '3']) {
        await Bun.write(join(root, app, `${name}.ts`), `export const who = '${app}${name}';\n`);
      }
      await Bun.write(join(root, `${app}.test.ts`), loader(app));
    }
    // `--isolate` in one process is what `--parallel` does per worker: the files run in turn, each
    // with a fresh copy of this package's modules and the one module cache between them.
    const child = Bun.spawn(['bun', 'test', '--isolate', './a.test.ts', './b.test.ts'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, failed: `${out}${err}`.match(/\(fail\)[^\n]*/g) ?? [] }).toEqual({
      code: 0,
      failed: [],
    });
    expect(`${out}${err}`).toContain('2 pass');
  }, 30_000);
});
