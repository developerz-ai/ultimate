// A shape's generators, run in the app `x new` wrote: what each wrote is answered, and one that
// refuses stops the run as X_NEW_SHAPE_GENERATE_FAILED naming the command that reproduces it.

import { expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive delete; `node:fs` owns the throwaway parent.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { writeNewApp } from './cmd-new';
import type { CommandContext } from './command';
import { runShapeGenerators } from './new-shapes-generate';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const contextIn = (cwd: string): CommandContext => ({
  args: parseArgs(['new', 'ops'], SPECS),
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

test('each generator runs in the app; a refusal is X_NEW_SHAPE_GENERATE_FAILED', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'x-new-shape-generate-'));
  try {
    const target = join(parent, 'ops');
    await writeNewApp(target, { name: 'ops', example: true });
    const signIn = ['sign-in', '--password'];
    const written = await runShapeGenerators(contextIn(parent), 'dashboard', target, [signIn]);
    expect(written).toContain('apps/web/app/auth/sign-in/page.tsx');
    expect(await runShapeGenerators(contextIn(parent), 'dashboard', target, [])).toEqual([]);
    // A second sign-in conflicts on every file: the run stops, and the fix reproduces it.
    const refused = await runShapeGenerators(contextIn(parent), 'dashboard', target, [signIn]).then(
      () => expect.unreachable('a second sign-in was written'),
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({ code: 'X_NEW_SHAPE_GENERATE_FAILED' });
    expect((refused as { fix: string }).fix).toContain('bunx x g sign-in --password --json');
    expect((refused as { cause: string }).cause).toContain('X_GENERATE_CONFLICT');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
