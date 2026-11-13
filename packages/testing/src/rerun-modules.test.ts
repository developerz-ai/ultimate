// The module ledger over Bun's real cache: what a module evaluated after a snapshot exports is
// read, and what one already evaluated before it exports is not.

import { expect, test } from 'bun:test';
// why: Bun ships no temp-directory or recursive-remove native.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path API.
import { join } from 'node:path';
import type { BunPlugin } from 'bun';
import { processModules } from './rerun-modules';

test('exportsSince reads only the modules evaluated after the snapshot', async () => {
  const before = processModules.snapshot();
  // A twin under a query: a module this process has not evaluated yet, with exports of its own.
  // A query of its own per load, so a `--rerun-each` run does not find run 1's twin cached.
  const probe = `ledger-probe-${crypto.randomUUID()}`;
  const twin = (await import(`./rerun-modules.ts?${probe}`)) as {
    readonly processModules: unknown;
  };
  const values = processModules.exportsSince(before, '/not-this-file.test.ts');
  expect(values).toContain(twin.processModules);
  expect(values).not.toContain(processModules);
  // The file under test is never its own exporter, though the cache holds it once its body is done.
  const self = Object.keys(require.cache).find((key) => key.endsWith(`?${probe}`)) ?? '';
  expect(processModules.exportsSince(before, self)).not.toContain(twin.processModules);
});

// `x dev`'s and `x serve`'s fixtures import pages through a loader plugin under `?x-reload=`, then
// delete the app. `require(key)` on such an entry went back through the plugin, whose async read
// of the deleted file was an unhandled ENOENT at the file's end (`serve-web.test.ts`, 2026-11-13).
// The cache entry already holds the namespace: reading it evaluates and reads nothing.
test('a module whose file is gone is read from the cache, never loaded again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rerun-modules-gone-'));
  const file = join(dir, 'page.tsx');
  await Bun.write(file, 'export const marker = { gone: true };\n');
  const loads: string[] = [];
  const plugin: BunPlugin = {
    name: 'rerun-modules-gone',
    setup(build) {
      build.onLoad({ filter: /rerun-modules-gone-.*page\.tsx(?:\?[^/]*)?$/ }, async ({ path }) => {
        loads.push(path);
        return { contents: await Bun.file(path.replace(/\?.*$/, '')).text(), loader: 'tsx' };
      });
    },
  };
  Bun.plugin(plugin);
  const before = processModules.snapshot();
  const page = (await import(`${file}?x-reload=1`)) as { readonly marker: unknown };
  await rm(dir, { recursive: true, force: true });
  const seen = loads.length;
  const values = processModules.exportsSince(before, '/not-this-file.test.ts');
  expect(values).toContain(page.marker);
  expect(loads).toHaveLength(seen);
});
