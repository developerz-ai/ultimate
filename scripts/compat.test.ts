// `compat.ts`'s command line over injected spawns and a temp tree: `run` runs the named part of the
// named cell and answers a finding per failing test, `file` reads part documents back (refusing one
// it cannot read), and an unknown command, cell or part is refused before anything spawns.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive; the part documents live in a temp tree.
import { join } from 'node:path';
import { compat } from './compat';
import type { PartDoc } from './compat-part';
import type { RunResult } from './lib/run';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';

// Reads the real compat.yml matrix, so the file runs on the repo-scan budget.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

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
  steps: [{ name: 'live', ok: false, output: 'packages/a.live.test.ts:\n(fail) a > b [1ms]' }],
});

const refusal = async (argv: readonly string[]): Promise<string> => {
  try {
    await compat(argv, repoRoot());
  } catch (cause) {
    if (cause instanceof ScriptError) return `${cause.code}: ${cause.cause}`;
    throw cause;
  }
  return expect.unreachable('the command was accepted');
};

describe('unit · compat · run', () => {
  test('a red part answers X_COMPAT_CELL_RED per failing test, its replay the fix', async () => {
    const asked: string[] = [];
    const runner = async (command: readonly string[]): Promise<RunResult> => {
      asked.push(command.join(' '));
      return result(RED, 1);
    };
    const answer = await compat(['run', '--cell', 'postgres-18', '--part', 'live-2'], repoRoot(), {
      runner,
    });
    expect(asked).toEqual(['bun run scripts/verify.ts --only live --shard 2/2 --json']);
    expect(answer.ok).toBe(false);
    expect(answer.findings?.map((one) => [one.code, one.at])).toEqual([
      ['X_COMPAT_CELL_RED', 'packages/a.live.test.ts'],
    ]);
    expect(answer.findings?.[0]?.fix).toContain('--cell postgres-18');
    expect((answer.data as PartDoc).cell).toBe('postgres-18');
  });

  test('an unknown command, cell or part is refused before anything runs', async () => {
    expect(await refusal(['lint'])).toContain('X_CLI_BAD_FLAG');
    expect(await refusal(['run', '--cell', 'bun-nightly', '--part', 'unit-1'])).toContain(
      'bun-nightly',
    );
    expect(await refusal(['run', '--cell', 'bun-latest', '--part', 'unit-9'])).toContain('unit-9');
    expect(await refusal(['run', '--cell', 'bun-latest'])).toContain('--part');
  });
});

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('unit · compat · prepare', () => {
  test('prepares the named cell from the real matrix and reports as compat', async () => {
    dir = await mkdtemp(join(tmpdir(), 'compat-prepare-'));
    const out = join(dir, 'override.yml');
    const answer = await compat(
      ['prepare', '--cell', 'postgres-16', '--compose-out', out],
      repoRoot(),
    );
    expect([answer.ok, answer.script]).toEqual([true, 'compat']);
    expect(await Bun.file(out).text()).toContain('pg16');
  });
});

describe('unit · compat · file', () => {
  test('reads part documents back, refuses one it cannot read, and files per cell', async () => {
    dir = await mkdtemp(join(tmpdir(), 'compat-file-'));
    const runner = async (): Promise<RunResult> => result(RED, 1);
    const red = await compat(['run', '--cell', 'bun-canary', '--part', 'unit-1'], repoRoot(), {
      runner,
    });
    const good = join(dir, 'bun-canary--unit-1.json');
    await Bun.write(good, JSON.stringify({ ok: red.ok, data: red.data }));
    const bad = join(dir, 'junk.json');
    await Bun.write(
      bad,
      JSON.stringify({
        ok: true,
        data: { cell: 'bun-canary', part: 'live-1', ok: true, failures: [] },
      }),
    );
    const asked: string[] = [];
    const gh = async (args: readonly string[]): Promise<RunResult> => {
      asked.push(
        args[0] === 'issue' ? `${args[1]} ${args[args.indexOf('--title') + 1] ?? ''}` : '',
      );
      return result(args[1] === 'list' ? '[]' : '', 0);
    };
    const answer = await compat(['file', good, bad], repoRoot(), { gh });
    expect(answer.findings?.map((one) => one.code)).toEqual(['X_COMPAT_UNREADABLE']);
    // Every cell of the real matrix is red here — five of them wrote no document at all.
    expect(asked.filter((line) => line.startsWith('create')).length).toBe(6);
    expect(answer.summary).toContain('6 red');
  });
});
