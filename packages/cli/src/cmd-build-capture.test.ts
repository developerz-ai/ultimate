// `x build --no-capture` reaches the app's own `prerender.ts` through ONE env name, and only the
// static target takes the flag — the gate's builds pass it, a deployable build takes the pictures.

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { BUILD_CAPTURE_ENV } from './build-capture-env';
import { buildCommand } from './cmd-build';
import type { ExecOptions, Runner } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function staticApp(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'x-build-capture-'));
  dirs.push(dir);
  await Bun.write(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  await Bun.write(join(dir, 'apps/web/prerender.ts'), 'export {};\n');
  await Bun.write(join(dir, 'apps/web/server.ts'), 'export {};\n');
  return dir;
}

async function build(argv: readonly string[]): Promise<readonly ExecOptions[]> {
  const cwd = await staticApp();
  const seen: ExecOptions[] = [];
  const runner: Runner = async (command, options) => {
    seen.push(options);
    return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 1 };
  };
  await buildCommand.run({
    args: parseArgs(argv, SPECS),
    cwd,
    runner,
    env: {},
    bunVersion: REQUIRED_BUN,
  });
  return seen;
}

test('--no-capture spawns the static builder with the capture switched off', async () => {
  const seen = await build(['build', '--target', 'static', '--no-preflight', '--no-capture']);
  expect(seen.at(-1)?.env).toEqual({ [BUILD_CAPTURE_ENV]: 'off' });
});

test('a plain static build sets nothing, so the export photographs its cards', async () => {
  const seen = await build(['build', '--target', 'static', '--no-preflight']);
  expect(seen.at(-1)?.env).toBeUndefined();
});

test('--no-capture on a target that photographs nothing is refused, never dropped', async () => {
  let code: string | undefined;
  try {
    await build(['build', '--target', 'binary', '--no-preflight', '--no-capture']);
  } catch (error) {
    code = (error as { code?: string }).code;
  }
  expect(code).toBe('X_CLI_BAD_FLAG');
});
