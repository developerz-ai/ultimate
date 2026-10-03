// The gate's SERIAL suites (`live`, `e2e`) run an argv, not a file list, so their ignore patterns
// are the selection: `**/build/**` there dropped the `*.live.test.ts` of an app slice named `build`
// from the gate while `x test` ran it. Proven by running the step's own argv in a scratch tree.

import { expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { testStepCommand } from './verify-tests';

const MARKING = (name: string): string =>
  `import { test } from 'bun:test';\ntest('marks', async () => { await Bun.write(${JSON.stringify(`${name}.ran`)}, ''); });\n`;

test('a slice named build keeps its live test on the gate; the root build/ does not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'x-verify-anchor-'));
  const files = {
    slice: 'apps/web/app/build/live/build-list.live.test.ts',
    example: 'apps/web/app/examples/page.live.test.ts',
    rootBuild: 'build/out.live.test.ts',
    nested: 'examples/dummy/a.live.test.ts',
    dist: 'packages/x/dist/b.live.test.ts',
  };
  try {
    for (const [name, path] of Object.entries(files)) {
      await Bun.write(join(root, path), MARKING(join(root, name)));
    }
    const child = Bun.spawn([...testStepCommand('live')], {
      cwd: root,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await child.exited;
    const ran = async (name: string): Promise<boolean> =>
      Bun.file(join(root, `${name}.ran`)).exists();
    expect({
      slice: await ran('slice'),
      example: await ran('example'),
      rootBuild: await ran('rootBuild'),
      nested: await ran('nested'),
      dist: await ran('dist'),
    }).toEqual({ slice: true, example: true, rootBuild: false, nested: false, dist: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
