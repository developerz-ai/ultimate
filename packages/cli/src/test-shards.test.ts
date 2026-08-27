// The run has to be reproducible: the line a failure prints has to reselect exactly the files that
// ran. The argv one `bun test` receives, the shard form `--worker` takes, and every input the
// reproduction carries back are asserted here — nowhere else.
//
// WHAT LEFT WHEN THE PACKER DID. The determinism and balance cases below used to be about
// `planShards`, a largest-first greedy bin-packer over file SIZE. There is no packer any more —
// `bun test --parallel=N` hands each free worker the next file — so "is the split balanced?" is
// not a question this repo can answer about itself, and pretending otherwise with a fixture would
// be a test that cannot fail. What is left is what is still ours: the argv, and the reproduction.

import { describe, expect, test } from 'bun:test';
import { testCommand } from './cmd-test';
import type { ExecOptions, Runner } from './exec';
import { renderJson } from './output';
import { flagBool, flagString, parseArgs } from './parse';
import type { TestFile } from './test-select';
import { filesIn, reproduceFor, runShards, testArgs } from './test-shards';

interface Call {
  readonly command: readonly string[];
  readonly env: ExecOptions['env'];
  readonly cwd: string;
}

interface Recorder {
  readonly calls: Call[];
  readonly runner: Runner;
}

/** The exec seam, faked: these tests assert on the argv, never on a real process. */
const recorder = (fails = false): Recorder => {
  const calls: Call[] = [];
  const runner: Runner = async (command, options) => {
    calls.push({ command, env: options.env, cwd: options.cwd });
    const code = fails ? 1 : 0;
    return { command, code, ok: code === 0, stdout: 'ran', stderr: '', durationMs: 7 };
  };
  return { calls, runner };
};

/** Deliberately uneven: a handful of very large files plus a long tail of small ones. */
const corpus = (count: number): readonly TestFile[] =>
  Array.from({ length: count }, (_unused, index) => ({
    path: `packages/p${index % 5}/file-${String(index).padStart(3, '0')}.test.ts`,
    bytes: index % 7 === 0 ? 40_000 - index * 13 : 400 + ((index * 37) % 900),
  }));

const firstFix = (result: {
  steps?: readonly { findings: readonly { fix: string }[] }[];
}): string => result.steps?.flatMap((step) => [...step.findings])[0]?.fix ?? '';

const firstCode = (result: {
  steps?: readonly { findings: readonly { code: string }[] }[];
}): string => result.steps?.flatMap((step) => [...step.findings])[0]?.code ?? '';

describe('unit · the argv one bun test receives', () => {
  test('the whole selection is one --parallel run, files listed explicitly', () => {
    expect(testArgs({ files: ['b.test.ts', 'a.test.ts'], workers: 4 })).toEqual([
      'bun',
      'test',
      '--parallel=4',
      'a.test.ts',
      'b.test.ts',
    ]);
  });

  // The rule an arbitrary partition depends on. Half the framework's registries are
  // process-global, and a serial run only passes because glob order happens to put every
  // declaring file before every file that reads what it left behind — measured, a bare
  // `bun test packages/` is 282 failures and the same corpus under `--isolate` is 0.
  // `--parallel` implies it; the shard form has to say it, and that is the whole reason this
  // case names both branches rather than one.
  test('every file gets a fresh module registry, in both forms', () => {
    // `--parallel` implies `--isolate` (bun 1.4.0), so the flag is deliberately NOT repeated.
    expect(testArgs({ files: ['a.test.ts'], workers: 2 })).toContain('--parallel=2');
    expect(testArgs({ files: ['a.test.ts'], workers: 2, shard: 0 })).toContain('--isolate');
  });

  // 0-based on the flag, 1-based in bun's own grammar. Off by one here is a rerun of the wrong
  // eighth of the corpus, reported as the one that failed.
  test('--worker I is bun shard I+1 of N, serial within the shard', () => {
    expect(testArgs({ files: ['a.test.ts', 'b.test.ts'], workers: 8, shard: 3 })).toEqual([
      'bun',
      'test',
      '--isolate',
      '--shard=4/8',
      'a.test.ts',
      'b.test.ts',
    ]);
  });

  // Bun partitions round-robin over the list it is given, so a sorted list is what makes
  // `--shard=2/8` the same eighth on CI and on a laptop. Discovery order must not reach it.
  test('discovery order cannot change which file lands in which shard', () => {
    const files = corpus(20).map((file) => file.path);
    expect(testArgs({ files: [...files].reverse(), workers: 4, shard: 1 })).toEqual(
      testArgs({ files, workers: 4, shard: 1 }),
    );
  });

  test('filesIn is the inverse, and reads no flag as a filename', () => {
    const command = testArgs({ files: ['a.test.ts', 'b.test.ts'], workers: 8, shard: 3 });
    expect(filesIn(command)).toEqual(['a.test.ts', 'b.test.ts']);
  });
});

describe('unit · x test execution', () => {
  test('one bun test carries every selected file, once', async () => {
    const { calls, runner } = recorder();
    const files = corpus(40);
    await runShards({ root: '/repo', runner, files, workers: 4 });

    expect(calls.length).toBe(1);
    expect(calls[0]?.cwd).toBe('/repo');
    expect(filesIn(calls[0]?.command ?? [])).toEqual([...files.map((f) => f.path)].sort());
    // Bun numbers its own workers with `BUN_TEST_WORKER_ID`, which `@ultimat3/testing`'s
    // `workerId` already reads — so a `--parallel` run must NOT pin every worker to one database
    // by exporting `ULTIMATE_TEST_WORKER`, which is that function's first key.
    expect(calls[0]?.env?.['ULTIMATE_TEST_WORKER']).toBeUndefined();
  });

  test('--worker reruns one shard, and names its own database', async () => {
    const { calls, runner } = recorder();
    await runShards({ root: '/repo', runner, files: corpus(40), workers: 4, only: 2 });

    expect(calls.length).toBe(1);
    expect(calls[0]?.command).toContain('--shard=3/4');
    // One process, so the database is this file's to name — the case above is the other half.
    expect(calls[0]?.env?.['ULTIMATE_TEST_WORKER']).toBe('2');
  });

  test('the width is clamped to the file count, so the reproduction is runnable', async () => {
    const { calls, runner } = recorder();
    const result = await runShards({ root: '/repo', runner, files: corpus(3), workers: 16 });
    expect(calls[0]?.command).toContain('--parallel=3');
    expect((result.data as { workers: number }).workers).toBe(3);
  });

  test('a failing run fails the command and names what reproduces it', async () => {
    const { runner } = recorder(true);
    const result = await runShards({ root: '/repo', runner, files: corpus(40), workers: 4 });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(firstCode(result)).toBe('X_TEST_FAILED');
    expect(firstFix(result)).toBe('x test --workers 4');
  });

  // Two codes because they name two different reruns, and both already exist: a shard is
  // reproduced by naming it, a whole run by rerunning it.
  test('a failing --worker run is the SHARD code, and its fix names the shard', async () => {
    const { runner } = recorder(true);
    const result = await runShards({
      root: '/repo',
      runner,
      files: corpus(40),
      workers: 4,
      only: 1,
    });
    expect(firstCode(result)).toBe('X_TEST_SHARD_FAILED');
    expect(firstFix(result)).toBe('x test --workers 4 --worker 1');
  });

  test('a filter is carried into the reproduction command as --filter, not a bare positional', async () => {
    const { runner } = recorder(true);
    const result = await runShards({
      root: '/repo',
      runner,
      files: corpus(10),
      workers: 2,
      filter: 'packages/http',
    });
    expect(firstFix(result)).toBe('x test --filter packages/http --workers 2');
  });

  test('a type is carried into the reproduction command ahead of --filter', async () => {
    const { runner } = recorder(true);
    const result = await runShards({
      root: '/repo',
      runner,
      files: corpus(10),
      workers: 2,
      filter: 'packages/http',
      type: 'contract',
    });
    expect(firstFix(result)).toBe('x test contract --filter packages/http --workers 2');
  });

  test('--json reports the width, the file count, the exit code and the rerun', async () => {
    const { runner } = recorder(true);
    const result = await runShards({ root: '/repo', runner, files: corpus(40), workers: 4 });
    // The RENDERED payload, never `result.data`: this test names the `--json` contract, and an
    // agent parses what `renderJson` emitted. `JSON.parse` either throws or answers, so asserting
    // it is defined is an assertion that cannot fail.
    const { data } = JSON.parse(renderJson(result)) as {
      readonly data: {
        readonly workers: number;
        readonly files: number;
        readonly ok: boolean;
        readonly exitCode: number;
        readonly reproduce: string;
      };
    };
    expect(data.workers).toBe(4);
    expect(data.files).toBe(40);
    expect(data.ok).toBe(false);
    expect(data.exitCode).toBe(1);
    expect(data.reproduce).toBe('x test --workers 4');
  });

  test('a pass exits zero and the step is named for the width it ran at', async () => {
    const { runner } = recorder();
    const result = await runShards({ root: '/repo', runner, files: corpus(9), workers: 3 });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.steps?.map((step) => step.ok)).toEqual([true]);
    expect(result.steps?.[0]?.name).toContain('3 worker(s) · 9 files');
  });

  test('a typed run uses the .type. summary keys and names its type in data', async () => {
    const { runner } = recorder();
    const result = await runShards({
      root: '/repo',
      runner,
      files: corpus(6),
      workers: 2,
      type: 'contract',
    });
    expect(result.summary).toContain('contract');
    expect((result.data as { type?: string }).type).toBe('contract');
  });
});

describe('unit · x test --sample is part of the selection', () => {
  const sampled = (only?: number) =>
    runShards({
      root: '/repo',
      runner: recorder(true).runner,
      files: corpus(10).slice(0, 3),
      workers: 2,
      type: 'eval',
      sample: { kept: 3, total: 10 },
      ...(only === undefined ? {} : { only }),
    });

  test('a sampled run names kept/total and is flagged in the human lines, not just data', async () => {
    const result = await sampled();
    expect(result.data).toMatchObject({ sample: { kept: 3, total: 10 } });
    expect(result.lines?.[0]).toContain('sampled 3 of 10');
  });

  test('the reproduction carries --sample, so the rerun selects the same corpus', async () => {
    expect(firstFix(await sampled())).toBe('x test eval --sample 3 --workers 2');
  });

  test('a --worker report names the sample it split, not the one shard that ran', async () => {
    // The bug this pins: kept was counted from what ran, so `--worker 1` of a 3-file sample
    // reported its own files as the corpus and printed a fix with no --sample at all.
    const result = await sampled(1);
    expect(result.data).toMatchObject({ sample: { kept: 3, total: 10 } });
    expect(result.lines?.[0]).toContain('sampled 3 of 10');
    expect(firstFix(result)).toBe('x test eval --sample 3 --workers 2 --worker 1');
  });
});

describe('unit · reproduceFor', () => {
  // Against the command's real spec, not a fixture: a reproduction the shipped parser rejects is
  // not a reproduction, and a fixture would go on agreeing with itself after the flags changed.
  test('round-trips through parseArgs to the same type, filter, sample, workers and worker', () => {
    const command = reproduceFor({
      workers: 5,
      filter: 'packages/http',
      type: 'contract',
      sample: 4,
      shard: 2,
    });
    expect(command).toBe(
      'x test contract --filter packages/http --sample 4 --workers 5 --worker 2',
    );
    const parsed = parseArgs(command.split(' ').slice(1), [testCommand.spec]);
    expect(parsed.positionals[0]).toBe('contract');
    expect(flagString(parsed, 'filter')).toBe('packages/http');
    expect(flagString(parsed, 'sample')).toBe('4');
    expect(flagString(parsed, 'workers')).toBe('5');
    expect(flagString(parsed, 'worker')).toBe('2');
  });

  // No shard means the whole selection, so `--worker` must be ABSENT rather than `--worker 0`:
  // that would rerun one eighth of the corpus and report it as the run that failed.
  test('no shard reproduces the whole run, with no --worker at all', () => {
    const command = reproduceFor({ workers: 3 });
    expect(command).toBe('x test --workers 3');
    expect(flagString(parseArgs(command.split(' ').slice(1), [testCommand.spec]), 'worker')).toBe(
      undefined,
    );
  });

  // The input most easily dropped: `--affected` decides which files exist to run at all, so a
  // rerun without it selects the whole corpus. Round-tripped through the real spec for the reason
  // the case above is.
  test('the --affected narrowing survives into the rerun, base and all', () => {
    const command = reproduceFor({
      workers: 4,
      affected: { base: 'origin/main', dirty: false },
      shard: 2,
    });
    expect(command).toBe('x test --affected --base origin/main --workers 4 --worker 2');

    const parsed = parseArgs(command.split(' ').slice(1), [testCommand.spec]);
    expect(flagBool(parsed, 'affected')).toBe(true);
    expect(flagString(parsed, 'base')).toBe('origin/main');
    expect(flagString(parsed, 'worker')).toBe('2');
  });

  test('--dirty survives too, because it changes which files the run saw', () => {
    expect(reproduceFor({ workers: 2, affected: { base: 'main', dirty: true }, shard: 1 })).toBe(
      'x test --affected --base main --dirty --workers 2 --worker 1',
    );
  });

  test('a filter with whitespace stays one argument, not two', () => {
    expect(reproduceFor({ workers: 2, filter: 'my tests/http' })).toBe(
      "x test --filter 'my tests/http' --workers 2",
    );
  });

  test('a filter with shell punctuation cannot become a second command', () => {
    expect(reproduceFor({ workers: 2, filter: 'a; rm -rf b', shard: 1 })).toBe(
      "x test --filter 'a; rm -rf b' --workers 2 --worker 1",
    );
  });

  test('a single quote is escaped the one way a single-quoted string allows', () => {
    // `'it'\''s slow'` — close, an escaped quote, reopen. Anything else truncates the argument.
    expect(reproduceFor({ workers: 1, filter: "it's slow" })).toBe(
      "x test --filter 'it'\\''s slow' --workers 1",
    );
  });
});
