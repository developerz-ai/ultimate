// The drain section a container's boot hands its web server, read off the app's own config.

import { expect, test } from 'bun:test';
// why: Bun has no mkdtemp, and the fixtures are written synchronously.
import { mkdtempSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { loadDrainConfig } from './serve-drain';

const appWith = (config: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'serve-drain-'));
  writeFileSync(join(root, 'app.config.ts'), `export const config = ${config};\n`);
  return root;
};

test('the declared readiness grace is read off app.config.ts', async () => {
  expect(await loadDrainConfig(appWith('{ drain: { readinessGraceMs: 7000 } }'))).toEqual({
    readinessGraceMs: 7000,
  });
});

test('no drain section, or no config at all, leaves the default to core', async () => {
  expect(await loadDrainConfig(appWith('{ name: "x" }'))).toBeUndefined();
  expect(await loadDrainConfig(mkdtempSync(join(tmpdir(), 'serve-drain-none-')))).toBeUndefined();
});
