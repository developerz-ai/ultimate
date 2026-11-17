// One real `bun test` over fixture files in its own temp dir, under this package's preload: the
// cross-file half of the registry guard is only observable in a child process. Shared by
// `registry-leak-guard.test.ts` (what is reported) and `registry-boundary.test.ts` (what is restored).

// why: `node:` by necessity, all four: Bun writes files but exposes no primitive that MAKES a
// uniquely named directory, no recursive REMOVE, no temp-dir location and no path join. Fixtures
// live outside the checkout — a `.test.ts` inside it would be collected by the repo's own run.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PRELOAD = join(import.meta.dir, 'preload.ts');

/** One real `bun test`, its own temp dir: the cross-file half is only observable in a child. */
export const runFixtures = async (
  files: Readonly<Record<string, string>>,
): Promise<{ readonly output: string; readonly exitCode: number }> => {
  const dir = await mkdtemp(join(tmpdir(), 'x-leak-guard-'));
  try {
    for (const [name, source] of Object.entries(files)) await Bun.write(join(dir, name), source);
    // Awaited, never `Bun.spawnSync`: a synchronous wait holds the test worker's only thread, so
    // a child that does not come back is a worker the test timeout cannot end.
    const run = Bun.spawn({
      cmd: ['bun', 'test', '--preload', PRELOAD, '.'],
      cwd: dir,
      env: { ...process.env, ULTIMATE_TEST_ALLOW_NET: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
      // Below every caller's 30 s test timeout: a hung child is killed and read as a red run.
      timeout: 25_000,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    return { output: `${stdout}${stderr}`, exitCode };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
