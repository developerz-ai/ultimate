// A declared `rateLimit:` is counted in the process-wide store `@ultimat3/http` installs, and since
// 22.7 one worker runs many test files: a file that spent a caller's bucket left it spent for the
// next file, so an app's "the 31st call is a 429" test went red only when another file that called
// the same action as the same test actor happened to run first on its worker. The app preload
// resets the store at every file boundary, as it puts back globals and the env.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove; each run needs its own directory.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask the platform for it.
import { tmpdir } from 'node:os';
// why: Bun ships no path API; the fixtures import the store by absolute path.
import { join } from 'node:path';

import { ISOLATED_ENV } from './isolated-plugins';

const SRC = import.meta.dir;

const withoutIsolation = (env: NodeJS.ProcessEnv): Record<string, string | undefined> => {
  const { [ISOLATED_ENV]: _isolated, ...rest } = env;
  return rest;
};
const PRELOAD = join(SRC, 'preload.ts');
const HTTP = join(SRC, '..', '..', 'http', 'src', 'index.ts');

/** Spends the ONE token a 1-capacity bucket holds — the second file to run is the witness. */
const SPENDS = `import { expect, test } from 'bun:test';
import { installedRateLimitStore } from ${JSON.stringify(HTTP)};

test('the caller still has its one token', async () => {
  const decision = await installedRateLimitStore().take(
    'action:send|actor:test-user',
    { capacity: 1, refillPerSecond: 0.0001 },
    1,
    1_700_000_000_000,
  );
  expect(decision.allowed).toBe(true);
});
`;

describe('the app preload, across files in one worker', () => {
  test('a rate-limit bucket one file spent is full again in the next', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'x-rate-boundary-'));
    try {
      await Bun.write(join(dir, 'a.test.ts'), SPENDS);
      await Bun.write(join(dir, 'b.test.ts'), SPENDS);
      // Awaited, never `Bun.spawnSync`: a child that hangs must stay a worker the timeout can end.
      const run = Bun.spawn({
        cmd: ['bun', 'test', '--preload', PRELOAD, '.'],
        cwd: dir,
        // A shared worker, as `x test` runs an app's files: the isolated mode a parent `x verify`
        // marks its own workers with gives each file a fresh registry and registers no reset.
        env: { ...withoutIsolation(process.env), ULTIMATE_TEST_ALLOW_NET: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      const output = `${stdout}${stderr}`;
      expect({ exitCode, passed: output.includes('2 pass') }, output).toEqual({
        exitCode: 0,
        passed: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
