// `x test job --seed <n>`: the seed reaches every `bun test` child as `ULTIMATE_JOB_SIM_SEED`, the
// variable `simulateJobs` replays one seed from, and a seed that is not a uint32 is refused before
// any process starts. Apart from `cmd-test.test.ts`, whose `--filter cmd-test` case pins that name to one file.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive; `mkdtemp`/`rm` build and remove the tree discovered.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { JOB_SIM_SEED_ENV } from '@ultimat3/testing';
import { REQUIRED_BUN } from './app-root';
import { testCommand } from './cmd-test';
import type { ExecOptions, Runner } from './exec';
import { parseArgs } from './parse';

const recorder = () => {
  const envs: (ExecOptions['env'] | undefined)[] = [];
  const runner: Runner = async (command, options) => {
    envs.push(options.env);
    return { command, code: 0, ok: true, stdout: '', stderr: '', durationMs: 1 };
  };
  return { envs, runner };
};

const run = (argv: readonly string[], cwd: string, runner: Runner) =>
  testCommand.run({
    args: parseArgs(argv, [testCommand.spec]),
    cwd,
    runner,
    env: {},
    bunVersion: REQUIRED_BUN,
  });

describe('unit · x test --seed', () => {
  test('the seed is in every child’s environment, and absent without the flag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-x-test-seed-'));
    try {
      await Bun.write(join(root, 'pay.job.test.ts'), 'export {};\n');
      const seeded = recorder();
      await run(['test', 'job', '--seed', '7', '--workers', '1'], root, seeded.runner);
      expect(seeded.envs.length).toBeGreaterThan(0);
      expect(seeded.envs.every((env) => env?.[JOB_SIM_SEED_ENV] === '7')).toBe(true);

      const plain = recorder();
      await run(['test', 'job', '--workers', '1'], root, plain.runner);
      expect(plain.envs.some((env) => env?.[JOB_SIM_SEED_ENV] !== undefined)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a seed that is not a uint32 is refused before anything runs', async () => {
    const { envs, runner } = recorder();
    for (const bad of ['-1', '7abc', String(2 ** 32)]) {
      await expect(
        run(['test', 'job', '--seed', bad], import.meta.dir, runner),
      ).rejects.toMatchObject({ code: 'X_CLI_BAD_FLAG', fix: 'x test job --seed 7' });
    }
    expect(envs).toEqual([]);
  });
});
