// `flake-hunt.ts`'s command line over injected spawns: a round's flags reach the run, a red round
// reports one finding per failing test with its rerun as the fix, bad flags are refused before
// anything spawns, and `file` reads round documents back and refuses one it cannot read.

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive; the round documents live in a temp tree.
import { join } from 'node:path';
import { flakeHunt } from './flake-hunt';
import type { RunResult } from './lib/run';
import { ScriptError } from './lib/script-error';

const result = (output: string, code: number): RunResult => ({
  command: [],
  code,
  ok: code === 0,
  output,
  durationMs: 1,
  timedOut: false,
});

const RED = JSON.stringify({
  ok: false,
  steps: [{ ok: false, output: 'packages/a.test.ts:\n(fail) a > b [1ms]' }],
  data: { reproduce: 'x test unit --workers 2 -- --randomize --seed=42' },
});

describe('unit · flake-hunt · run', () => {
  test('a red round answers one X_FLAKE_HUNT_TEST_FAILED per test, its rerun the fix', async () => {
    const asked: string[] = [];
    const runner = async (command: readonly string[]): Promise<RunResult> => {
      asked.push(command.join(' '));
      return result(RED, 1);
    };
    const answer = await flakeHunt(
      ['run', '--suite', 'unit', '--seed', '42', '--round', '3'],
      '.',
      {
        runner,
      },
    );
    expect(asked[0]).toEndWith('test unit --json -- --randomize --seed=42');
    expect(answer.ok).toBe(false);
    expect(answer.findings).toEqual([
      {
        code: 'X_FLAKE_HUNT_TEST_FAILED',
        cause: 'packages/a.test.ts > a > b failed under --randomize --seed=42',
        fix: 'bun run x -- test unit --workers 2 -- --randomize --seed=42',
        at: 'packages/a.test.ts',
      },
    ]);
    expect(answer.data).toMatchObject({ round: 3, seed: 42 });
  });

  test.each([
    [['run', '--suite', 'e2e']],
    [['run', '--suite', 'unit', '--seed', '0']],
    [['run', '--suite', 'unit', '--seed', 'abc']],
    [['hunt']],
    [['file']],
  ])('refuses %j before anything spawns', async (argv) => {
    let spawned = false;
    const runner = async (): Promise<RunResult> => {
      spawned = true;
      return result('{}', 0);
    };
    const refusal = await flakeHunt(argv, '.', { runner }).catch((cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(ScriptError);
    expect((refusal as ScriptError).code).toBe('X_CLI_BAD_FLAG');
    expect(spawned).toBe(false);
  });
});

describe('unit · flake-hunt · file', () => {
  test('reads each round back, files its tests, and names a document it cannot read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ultimate-flake-hunt-'));
    try {
      const red = await flakeHunt(['run', '--suite', 'unit', '--seed', '42'], '.', {
        runner: async () => result(RED, 1),
      });
      const good = join(dir, 'unit-1.json');
      const junk = join(dir, 'live-1.json');
      await Bun.write(good, JSON.stringify(red));
      await Bun.write(junk, 'not a document');
      const created: string[] = [];
      const gh = async (args: readonly string[]): Promise<RunResult> => {
        if (args[0] === 'issue' && args[1] === 'create') created.push(args[5] ?? '');
        return result(args[1] === 'list' ? '[]' : '', 0);
      };
      const answer = await flakeHunt(['file', good, junk], '.', { gh });
      expect(created).toEqual(['flake: packages/a.test.ts > a > b']);
      expect(answer.ok).toBe(false);
      expect(answer.findings?.map((one) => one.code)).toEqual(['X_FLAKE_HUNT_UNREADABLE']);
      // The path is argv: carried verbatim when it is one inert shell word, a placeholder else.
      expect(answer.findings?.[0]?.fix).toEndWith(`> ${junk}`);
      const oddPath = join(dir, '$(boom).json');
      await Bun.write(oddPath, 'not a document');
      const odd = await flakeHunt(['file', oddPath], '.', { gh });
      expect(odd.findings?.[0]?.fix).toEndWith('> <round.json>');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
