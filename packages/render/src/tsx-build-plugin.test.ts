// A bundle built with `serverTsxBuildPlugin` carries the server factory's nodes, not Bun's own JSX
// output. Bun 1.4.3 refused such a build outright (issue #883), so this is the build that must work.

import { afterAll, expect, test } from 'bun:test';
// why: Bun ships no temp-directory maker and no recursive remove; `join` for the same reason.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { isJsxNode } from './jsx';
import { serverTsxBuildPlugin } from './tsx-build-plugin';

const made: string[] = [];
afterAll(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

test('a bundled .tsx evaluates to the framework factory node', async () => {
  // Anywhere: the prelude names the factory by absolute path, so nothing resolves from the fixture.
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-tsx-build-'));
  made.push(dir);
  const entry = join(dir, 'probe.tsx');
  await Bun.write(entry, "export const node = <main class='probe'><>hi</></main>;\n");
  const built = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    outdir: join(dir, 'out'),
    plugins: [serverTsxBuildPlugin],
    throw: false,
  });
  expect(built.logs.map(String)).toEqual([]);
  expect(built.success).toBe(true);
  const output = built.outputs[0];
  if (output === undefined) return expect.unreachable('the build emitted no output');
  const loaded = (await import(output.path)) as { node: unknown };
  expect(isJsxNode(loaded.node)).toBe(true);
});
