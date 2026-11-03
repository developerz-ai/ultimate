// `x g` formats what it wrote with the app's own Biome, under the app's own config. The real binary
// where the answer is what the formatter does, a recording runner where it is what `x g` asked for.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, chmod, symlink or recursive remove — a throwaway app root is node:fs's.
import { chmod, mkdtemp, rm, symlink } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { generateCommand } from './cmd-generate';
import type { CommandContext } from './command';
import type { ExecOptions, Runner } from './exec';
import { exec } from './exec';
import { formatWritten } from './generate-format-written';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const UGLY = 'export const a   =   {b:1}\n';
const CONFIG = JSON.stringify({
  formatter: { indentStyle: 'space' },
  javascript: { formatter: { quoteStyle: 'single', semicolons: 'always' } },
});

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-format-written-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const recording = (): { readonly runner: Runner; readonly calls: (readonly string[])[] } => {
  const calls: (readonly string[])[] = [];
  const runner: Runner = async (command, _options: ExecOptions) => {
    calls.push(command);
    return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 0 };
  };
  return { runner, calls };
};

/** What `bun install` links, without running anything: the runner above never spawns it. */
const installFakeBiome = async (): Promise<string> => {
  const bin = join(root, 'node_modules', '.bin', 'biome');
  await Bun.write(bin, '#!/bin/sh\nexit 0\n');
  await chmod(bin, 0o755);
  await Bun.write(join(root, 'biome.json'), CONFIG);
  return bin;
};

const installRealBiome = async (): Promise<void> => {
  await Bun.write(join(root, 'biome.json'), CONFIG);
  const real = Bun.which('biome', { PATH: join(REPO_ROOT, 'node_modules', '.bin') });
  if (real === null) return expect.unreachable('the repository has no biome: run bun install');
  await Bun.write(join(root, 'node_modules', '.bin', '.keep'), '');
  await symlink(real, join(root, 'node_modules', '.bin', 'biome'));
};

describe('unit · formatWritten', () => {
  test('rewrites what was written, and nothing beside it', async () => {
    await installRealBiome();
    await Bun.write(join(root, 'written.ts'), UGLY);
    await Bun.write(join(root, 'beside.ts'), UGLY);
    await formatWritten(root, ['written.ts'], exec);
    expect(await Bun.file(join(root, 'written.ts')).text()).toBe('export const a = { b: 1 };\n');
    expect(await Bun.file(join(root, 'beside.ts')).text()).toBe(UGLY);
  }, 30_000);

  test('a file Biome still refuses is the lint step to report, never a failed x g', async () => {
    await installRealBiome();
    await Bun.write(join(root, 'written.ts'), 'export default 1 +;\n');
    await formatWritten(root, ['written.ts'], exec);
    expect(await Bun.file(join(root, 'written.ts')).text()).toBe('export default 1 +;\n');
  }, 30_000);

  test('only TypeScript: a JSON catalog is merged by a writer that owns its order', async () => {
    const bin = await installFakeBiome();
    const { runner, calls } = recording();
    await formatWritten(root, ['a.ts', 'b.tsx', 'c.json', 'd.scss'], runner);
    expect(calls).toEqual([
      [bin, 'check', '--write', '--files-ignore-unknown=true', 'a.ts', 'b.tsx'],
    ]);
  });

  test('asks nothing with no file, no binary or no config: never a downloaded formatter', async () => {
    const { runner, calls } = recording();
    await formatWritten(root, ['a.ts'], runner);
    await Bun.write(join(root, 'biome.json'), CONFIG);
    await formatWritten(root, ['a.ts'], runner);
    await rm(join(root, 'biome.json'));
    await installFakeBiome();
    await rm(join(root, 'biome.json'));
    await formatWritten(root, ['a.ts'], runner);
    await Bun.write(join(root, 'biome.json'), CONFIG);
    await formatWritten(root, [], runner);
    expect(calls).toEqual([]);
  });
});

describe('unit · x g formats through the command runner', () => {
  const contextFor = (argv: readonly string[], runner: Runner): CommandContext => ({
    args: parseArgs(argv, SPECS),
    cwd: root,
    runner,
    env: {},
    bunVersion: REQUIRED_BUN,
  });

  test('every TypeScript file the run wrote, once, and not on a dry run', async () => {
    await Bun.write(join(root, 'app.config.ts'), 'export default {};\n');
    const bin = await installFakeBiome();
    const { runner, calls } = recording();

    await generateCommand.run(contextFor(['g', 'task', 'nightly', '--dry-run'], runner));
    expect(calls).toEqual([]);

    const result = await generateCommand.run(contextFor(['g', 'task', 'nightly'], runner));
    const files = (result.data as { files: readonly string[] }).files;
    expect(calls.length).toBe(1);
    expect(calls[0]?.slice(0, 4)).toEqual([bin, 'check', '--write', '--files-ignore-unknown=true']);
    const asked = calls[0]?.slice(4) ?? [];
    expect(asked.length).toBeGreaterThan(0);
    for (const path of asked) expect(files).toContain(path);
    expect(asked).toContain('apps/web/app/nightly/tasks/nightly.ts');
  });
});
