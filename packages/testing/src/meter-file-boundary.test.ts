// A declared `meter:` is counted in the process-wide store `@ultimat3/action` installs, and one
// worker runs many test files: a file that spent a tenant's daily allowance left it spent for the
// next file, so an app's "the 101st draft is refused" test was red whenever another file drafting
// as the same seeded org ran first on its worker. The app preload resets the meter store at every
// file boundary, as it does the rate-limit store.

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
const ACTION = join(SRC, '..', '..', 'action', 'src', 'index.ts');

/** Draws the ONE call a 1-call meter allows — the second file to run is the witness. */
const DRAWS = `import { expect, test } from 'bun:test';
import { getMeterStore } from ${JSON.stringify(ACTION)};

test('the tenant still has its one call', async () => {
  const drawn = await getMeterStore().draw({
    subject: 'org:test-org',
    meter: 'posts',
    period: 'day@UTC',
    periodStartMs: 1_700_000_000_000,
    limit: 1,
  });
  expect(drawn.allowed).toBe(true);
});
`;

describe('the app preload, across files in one worker', () => {
  test('a meter one file spent is whole again in the next', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'x-meter-boundary-'));
    try {
      await Bun.write(join(dir, 'a.test.ts'), DRAWS);
      await Bun.write(join(dir, 'b.test.ts'), DRAWS);
      // Awaited, never `Bun.spawnSync`: a child that hangs must stay a worker the timeout can end.
      const run = Bun.spawn({
        cmd: ['bun', 'test', '--preload', PRELOAD, '.'],
        cwd: dir,
        // A shared worker, as `x test` runs an app's files: the isolated mode registers no reset.
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
