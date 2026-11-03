// The frozen instant is one process' too: a file that advanced the clock and never put it back
// handed every later file on its worker a clock 2.8 s on (`x tasks`' `lastFiredAtMs`, measured
// behind `runtime-bus.live.test.ts`'s backoff poll). Both preloads put the installed instant back
// at every file boundary, as they put back globals, the env and the lifecycle.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove; each run needs its own directory.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask the platform for it.
import { tmpdir } from 'node:os';
// why: Bun ships no path API; the fixtures import the clock by absolute path.
import { join } from 'node:path';
import { ISOLATED_ENV } from './isolated-plugins';

const SRC = import.meta.dir;
const REPO_PRELOAD = join(SRC, '..', '..', '..', 'scripts', 'test-setup.ts');

/** Starts on the installed instant, then leaves the clock moved: the second file is the witness. */
const MOVES = `import { expect, test } from 'bun:test';
import { advanceClock, DEFAULT_NOW } from ${JSON.stringify(join(SRC, 'determinism.ts'))};

test('the file starts on the installed instant', () => {
  expect(Date.now()).toBe(Date.parse(DEFAULT_NOW));
  advanceClock(2_800);
});
`;

const withoutIsolation = (env: NodeJS.ProcessEnv): Record<string, string | undefined> => {
  const { [ISOLATED_ENV]: _isolated, ...rest } = env;
  return rest;
};

describe('a clock one file moved is the installed instant again in the next', () => {
  test.each([
    ['the app preload', join(SRC, 'preload.ts')],
    ["the framework's own preload", REPO_PRELOAD],
  ])(
    '%s',
    async (_name, preload) => {
      const dir = await mkdtemp(join(tmpdir(), 'x-clock-boundary-'));
      try {
        await Bun.write(join(dir, 'a.test.ts'), MOVES);
        await Bun.write(join(dir, 'b.test.ts'), MOVES);
        // Awaited, never `Bun.spawnSync`: a hung child stays a worker the timeout can end.
        const run = Bun.spawn({
          cmd: ['bun', 'test', '--preload', preload, '.'],
          cwd: dir,
          // One shared worker, as `x test` runs an app's files.
          env: { ...withoutIsolation(process.env), ULTIMATE_TEST_ALLOW_NET: '1' },
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 60_000,
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
    },
    60_000,
  );
});
