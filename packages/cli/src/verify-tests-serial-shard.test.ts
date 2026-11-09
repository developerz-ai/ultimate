// `--shard i/n` over a SERIAL suite: each CI runner owns its own Postgres and browser, so a slice of
// `live` or `e2e` on one runner shares nothing with another runner's. Inside a slice the suite stays
// one process, which is what makes it serial in the first place.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive: `mkdtemp`/`rm` build and remove the throwaway tree.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { ExecOptions, ExecResult } from './exec';
import { filesIn } from './test-shards';
import { corpusHash } from './verify-shard';
import type { VerifyContext, VerifyStep } from './verify-step';
import { resetTestDiscovery, TEST_STEPS, testStepCommand } from './verify-tests';

let root = '';
const calls: (readonly string[])[] = [];

const runner = async (command: readonly string[], _options?: ExecOptions): Promise<ExecResult> => {
  calls.push(command);
  return { command, ok: true, code: 0, stdout: '', stderr: '', durationMs: 1 };
};

const LIVE = ['pkg/a.live.test.ts', 'pkg/b.live.test.ts', 'pkg/c.live.test.ts'];

const live = (): VerifyStep => {
  const step = TEST_STEPS.find((candidate) => candidate.name === 'live');
  if (step === undefined) expect.unreachable('no live step');
  return step;
};

const shardCtx = (index: number, total: number): VerifyContext => ({
  root,
  runner,
  workers: 8,
  shard: { index, total },
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-verify-serial-shard-'));
  for (const path of LIVE) await Bun.write(join(root, path), '// live\n');
  await Bun.write(join(root, 'pkg/unit.test.ts'), '// unit\n');
  resetTestDiscovery();
});

afterAll(async () => {
  resetTestDiscovery();
  await rm(root, { recursive: true, force: true });
});

describe('unit · a serial suite splits by file across runners', () => {
  test('shard 1/2 of live runs ONE serial bun test over exactly its slice', async () => {
    calls.length = 0;
    const outcome = await live().run(shardCtx(1, 2));
    expect(calls.length).toBe(1);
    const command = calls[0] ?? [];
    expect(command.slice(0, 2)).toEqual(['bun', 'test']);
    expect(command.some((arg) => arg.startsWith('--parallel'))).toBe(false);
    expect(filesIn(command)).toEqual(['pkg/a.live.test.ts', 'pkg/c.live.test.ts']);
    expect(outcome.workers).toBe(1);
    expect(outcome.shard).toEqual({
      index: 1,
      total: 2,
      corpusHash: corpusHash(LIVE),
      files: ['pkg/a.live.test.ts', 'pkg/c.live.test.ts'],
    });
  });

  test('the shards together run every live file exactly once, and no unit file', async () => {
    calls.length = 0;
    await live().run(shardCtx(1, 2));
    await live().run(shardCtx(2, 2));
    expect(calls.flatMap((command) => filesIn(command)).sort()).toEqual(LIVE);
  });

  test('an empty slice spawns nothing and reports zero tests with its facts', async () => {
    calls.length = 0;
    const outcome = await live().run(shardCtx(4, 4));
    expect(calls.length).toBe(0);
    expect(outcome.ok).toBe(true);
    expect(outcome.tests).toEqual({ ran: 0, skipped: 0 });
    expect(outcome.shard?.files).toEqual([]);
  });

  test('without --shard, live still runs as one process over its own argv', async () => {
    calls.length = 0;
    const outcome = await live().run({ root, runner, workers: 8 });
    expect(calls.length).toBe(1);
    expect(outcome.shard).toBeUndefined();
    expect(calls[0]).toEqual(testStepCommand('live'));
  });
});
