// One exclusion policy for both selectors: `discoverTests` (the parallel steps and `x test`) and
// the serial steps' `--path-ignore-patterns`. Two hand-kept copies disagreed — the serial argv
// never named `node_modules` — and the next edit to one would drift the gate from `x test`.

import { expect, test } from 'bun:test';
// why: Bun has no temp-directory API and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { discoverTests } from './test-select';
import { testStepCommand } from './verify-tests';

const SAMPLES = [
  'apps/web/app/build/a.live.test.ts',
  'apps/web/app/examples/b.live.test.ts',
  'apps/web/app/dummy/c.live.test.ts',
  'build/d.live.test.ts',
  'examples/e.live.test.ts',
  'dummy/f.live.test.ts',
  'dist/g.live.test.ts',
  'packages/x/dist/h.live.test.ts',
  'node_modules/p/i.live.test.ts',
  'packages/x/node_modules/p/j.live.test.ts',
];

/** What the serial `live` step's own argv excludes, read off its `--path-ignore-patterns`. */
const serialIgnores = (path: string): boolean =>
  testStepCommand('live')
    .filter((arg) => arg.startsWith('--path-ignore-patterns='))
    .map((arg) => arg.slice('--path-ignore-patterns='.length))
    .some((pattern) => new Bun.Glob(pattern).match(path));

test('discovery and the serial steps exclude exactly the same paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'x-test-ignores-'));
  try {
    for (const path of SAMPLES) await Bun.write(join(root, path), 'export {};\n');
    const discovered = new Set((await discoverTests(root, undefined, 'live')).map((f) => f.path));
    const verdicts = SAMPLES.map((path) => ({
      path,
      discovery: !discovered.has(path),
      serial: serialIgnores(path),
    }));
    expect(verdicts.filter((row) => row.discovery !== row.serial)).toEqual([]);
    expect(verdicts.filter((row) => !row.serial).map((row) => row.path)).toEqual(
      SAMPLES.slice(0, 3),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
