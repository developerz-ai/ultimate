// `x build --target prebuilt` writes the module registry a serving role boots from — and none over
// an app with a module that would not import, so that boot scans and refuses with the cause.

import { expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { setSassCacheDir } from '@ultimat3/render/server';
import { REQUIRED_BUN } from './app-root';
import { readPrebuiltRegistry } from './build-registry';
import { buildCommand } from './cmd-build';
import type { CommandContext } from './command';
import { parseArgs } from './parse';
import { SPECS } from './registry';

async function buildRoot(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-image-prepare-'));
  await Bun.write(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  await Bun.write(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  await Bun.write(join(dir, 'apps/web/server.ts'), 'export {};\n');
  for (const [path, source] of Object.entries(files)) await Bun.write(join(dir, path), source);
  return dir;
}

const prebuilt = (cwd: string): CommandContext => ({
  args: parseArgs(['build', '--target', 'prebuilt'], SPECS),
  cwd,
  runner: async (command) => ({
    command,
    code: 0,
    ok: true,
    stdout: '',
    stderr: '',
    durationMs: 0,
  }),
  env: {},
  bunVersion: REQUIRED_BUN,
});

test('--target prebuilt writes the registry of every module the scan imported, in its order', async () => {
  const dir = await buildRoot({
    'apps/web/site/home.ts': 'export const home = 1;\n',
    'apps/web/site/about.ts': 'export const about = 1;\n',
    'apps/web/site/home.test.ts': 'export {};\n',
  });
  try {
    const result = await buildCommand.run(prebuilt(dir));
    expect(result.ok).toBe(true);
    expect((await readPrebuiltRegistry(dir))?.files).toEqual([
      'apps/web/site/about.ts',
      'apps/web/site/home.ts',
    ]);
  } finally {
    setSassCacheDir(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test('--target prebuilt writes no registry over a module that would not import', async () => {
  const dir = await buildRoot({
    'apps/web/site/broken.ts': "import './never-written';\nexport const broken = 1;\n",
  });
  try {
    expect((await buildCommand.run(prebuilt(dir))).ok).toBe(false);
    expect(await readPrebuiltRegistry(dir)).toBeUndefined();
  } finally {
    setSassCacheDir(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
