// The split has to be reproducible: the same files in produce the same shards out, and the line a
// failed shard prints has to reselect exactly those files. Determinism, balance, the argv each
// child receives, and every input the reproduction carries back are asserted here — nowhere else.

import { describe, expect, test } from 'bun:test';
import { testCommand } from './cmd-test';
import type { ExecOptions, Runner } from './exec';
import { renderJson } from './output';
import { flagString, parseArgs } from './parse';
import type { TestFile } from './test-select';
import type { Shard } from './test-shards';
import { planShards, quoteArg, reproduceFor, runShards, shardArgs } from './test-shards';

interface Call {
  readonly command: readonly string[];
  readonly env: ExecOptions['env'];
  readonly cwd: string;
}

interface Recorder {
  readonly calls: Call[];
  readonly runner: Runner;
}

/** The exec seam, faked: these tests assert on the split and the argv, never on a real process. */
const recorder = (failing: readonly number[] = []): Recorder => {
  const calls: Call[] = [];
  const runner: Runner = async (command, options) => {
    calls.push({ command, env: options.env, cwd: options.cwd });
    const worker = Number.parseInt(options.env?.['ULTIMATE_TEST_WORKER'] ?? '-1', 10);
    const code = failing.includes(worker) ? 1 : 0;
    return { command, code, ok: code === 0, stdout: `worker ${worker}`, stderr: '', durationMs: 7 };
  };
  return { calls, runner };
};

/** Deliberately uneven: a handful of very large files plus a long tail of small ones. */
const corpus = (count: number): readonly TestFile[] =>
  Array.from({ length: count }, (_unused, index) => ({
    path: `packages/p${index % 5}/file-${String(index).padStart(3, '0')}.test.ts`,
    bytes: index % 7 === 0 ? 40_000 - index * 13 : 400 + ((index * 37) % 900),
  }));

const shuffled = (files: readonly TestFile[]): readonly TestFile[] => {
  const out = [...files];
  // Reverse plus a rotation: a fixed permutation, so the test itself stays deterministic.
  return [...out.slice(17), ...out.slice(0, 17)].reverse();
};

const totalBytes = (files: readonly TestFile[]): number =>
  files.reduce((sum, file) => sum + file.bytes, 0);

const paths = (shards: readonly Shard[]): readonly (readonly string[])[] =>
  shards.map((shard) => shard.files);

const firstFix = (result: {
  steps?: readonly { findings: readonly { fix: string }[] }[];
}): string => result.steps?.flatMap((step) => [...step.findings])[0]?.fix ?? '';

describe('unit · x test sharding', () => {
  test('the same file set produces the same split, every run', () => {
    const files = corpus(120);
    expect(paths(planShards(files, 6))).toEqual(paths(planShards(files, 6)));
  });

  test('discovery order cannot change the assignment', () => {
    const files = corpus(120);
    expect(paths(planShards(shuffled(files), 6))).toEqual(paths(planShards(files, 6)));
  });

  test('every file is assigned exactly once', () => {
    const files = corpus(97);
    const assigned = planShards(files, 8).flatMap((shard) => [...shard.files]);
    expect(assigned.length).toBe(files.length);
    expect(new Set(assigned).size).toBe(files.length);
  });

  test('largest-first greedy keeps every bin under average + largest file', () => {
    const files = corpus(200);
    const shards = planShards(files, 8);
    const largest = Math.max(...files.map((file) => file.bytes));
    const ceiling = totalBytes(files) / 8 + largest;
    for (const shard of shards) expect(shard.bytes).toBeLessThanOrEqual(ceiling);
  });

  test('the slow files are spread, not piled onto one worker', () => {
    // Four slow files whose names sort adjacently: round-robin over discovery order would put
    // every one of them on the same worker, which is the failure mode this algorithm exists for.
    const files: readonly TestFile[] = [
      { path: 'a/slow-1.test.ts', bytes: 90_000 },
      { path: 'a/slow-2.test.ts', bytes: 90_000 },
      { path: 'a/slow-3.test.ts', bytes: 90_000 },
      { path: 'a/slow-4.test.ts', bytes: 90_000 },
      ...Array.from({ length: 12 }, (_unused, index) => ({
        path: `b/fast-${index}.test.ts`,
        bytes: 500,
      })),
    ];
    const shards = planShards(files, 4);
    for (const shard of shards) {
      expect(shard.files.filter((path) => path.includes('slow')).length).toBe(1);
    }
  });

  test('worker count never exceeds the file count, and never drops below one', () => {
    expect(planShards(corpus(3), 16).length).toBe(3);
    expect(planShards(corpus(50), 0).length).toBe(1);
    expect(planShards([], 8).length).toBe(1);
  });

  test('shardArgs never re-globs in the child: the file list is explicit', () => {
    const shard: Shard = { index: 1, files: ['a.test.ts', 'b.test.ts'], bytes: 2 };
    expect(shardArgs(shard)).toEqual(['bun', 'test', 'a.test.ts', 'b.test.ts']);
  });
});

describe('unit · x test execution', () => {
  test('each shard is one `bun test` carrying its own files and worker index', async () => {
    const { calls, runner } = recorder();
    const files = corpus(40);
    await runShards({ root: '/repo', runner, files, workers: 4 });
    expect(calls.length).toBe(4);
    const workers = calls.map((call) => call.env?.['ULTIMATE_TEST_WORKER']);
    expect([...workers].sort()).toEqual(['0', '1', '2', '3']);
    for (const call of calls) {
      expect(call.command.slice(0, 2)).toEqual(['bun', 'test']);
      expect(call.command.length).toBeGreaterThan(2);
      expect(call.cwd).toBe('/repo');
    }
    const passed = calls.flatMap((call) => call.command.slice(2));
    expect(new Set(passed).size).toBe(files.length);
  });

  test('--worker reruns exactly the shard CI ran, with the same files', async () => {
    const files = corpus(40);
    const expected = planShards(files, 4)[2];
    const { calls, runner } = recorder();
    await runShards({ root: '/repo', runner, files, workers: 4, only: 2 });
    expect(calls.length).toBe(1);
    expect(calls[0]?.env?.['ULTIMATE_TEST_WORKER']).toBe('2');
    expect(calls[0]?.command.slice(2)).toEqual([...(expected?.files ?? [])]);
  });

  test('a failing shard fails the run and names the command that reproduces it', async () => {
    const { runner } = recorder([1]);
    const result = await runShards({ root: '/repo', runner, files: corpus(40), workers: 4 });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const finding = result.steps?.flatMap((step) => [...step.findings])[0];
    expect(finding?.code).toBe('X_TEST_SHARD_FAILED');
    expect(finding?.fix).toBe('x test --workers 4 --worker 1');
  });

  test('a filter is carried into the reproduction command as --filter, not a bare positional', async () => {
    const { runner } = recorder([0]);
    const result = await runShards({
      root: '/repo',
      runner,
      files: corpus(10),
      workers: 2,
      filter: 'packages/http',
    });
    expect(firstFix(result)).toBe('x test --filter packages/http --workers 2 --worker 0');
  });

  test('a type is carried into the reproduction command ahead of --filter', async () => {
    const { runner } = recorder([0]);
    const result = await runShards({
      root: '/repo',
      runner,
      files: corpus(10),
      workers: 2,
      filter: 'packages/http',
      type: 'contract',
    });
    expect(firstFix(result)).toBe('x test contract --filter packages/http --workers 2 --worker 0');
  });

  test('every shard reports its files, pass/fail and duration in --json', async () => {
    const { runner } = recorder([3]);
    const result = await runShards({ root: '/repo', runner, files: corpus(40), workers: 4 });
    const parsed: unknown = JSON.parse(renderJson(result));
    expect(parsed).toBeDefined();
    const data = result.data as {
      readonly workers: number;
      readonly failed: readonly number[];
      readonly shards: readonly {
        readonly index: number;
        readonly files: number;
        readonly exitCode: number;
        readonly durationMs: number;
        readonly reproduce: string;
      }[];
    };
    expect(data.workers).toBe(4);
    expect(data.failed).toEqual([3]);
    expect(data.shards.length).toBe(4);
    expect(data.shards.reduce((sum, shard) => sum + shard.files, 0)).toBe(40);
    expect(data.shards[3]?.exitCode).toBe(1);
    expect(data.shards[0]?.durationMs).toBe(7);
    expect(data.shards[2]?.reproduce).toBe('x test --workers 4 --worker 2');
  });

  test('a whole-suite pass exits zero and every step is named for its shard', async () => {
    const { runner } = recorder();
    const result = await runShards({ root: '/repo', runner, files: corpus(9), workers: 3 });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.steps?.map((step) => step.ok)).toEqual([true, true, true]);
    expect(result.steps?.[0]?.name).toContain('shard 0');
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

describe('unit · x test --sample is part of the split', () => {
  const sampled = (only?: number) =>
    runShards({
      root: '/repo',
      runner: recorder([0, 1]).runner,
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
    const result = await sampled();
    expect(firstFix(result)).toBe('x test eval --sample 3 --workers 2 --worker 0');
  });

  test('a --worker report names the sample it split, not the one shard that ran', async () => {
    // The bug this pins: kept was counted from the shards that ran, so `--worker 1` of a 3-file
    // sample reported its own 2 files as the corpus and printed a fix with no --sample at all.
    const result = await sampled(1);
    expect(result.data).toMatchObject({ sample: { kept: 3, total: 10 }, files: 2 });
    expect(result.lines?.[0]).toContain('sampled 3 of 10');
    expect(firstFix(result)).toBe('x test eval --sample 3 --workers 2 --worker 1');
  });
});

describe('unit · reproduceFor', () => {
  const shard = (index: number): Shard => ({ index, files: ['a.test.ts'], bytes: 1 });

  // Against the command's real spec, not a fixture: a reproduction the shipped parser rejects is
  // not a reproduction, and a fixture would go on agreeing with itself after the flags changed.
  test('round-trips through parseArgs to the same type, filter, sample, workers and worker', () => {
    const command = reproduceFor(shard(2), {
      workers: 5,
      filter: 'packages/http',
      type: 'contract',
      sample: 4,
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

  test('no type, filter or sample matches today’s bare form', () => {
    expect(reproduceFor(shard(0), { workers: 3 })).toBe('x test --workers 3 --worker 0');
  });

  test('a filter with whitespace stays one argument, not two', () => {
    expect(reproduceFor(shard(0), { workers: 2, filter: 'my tests/http' })).toBe(
      "x test --filter 'my tests/http' --workers 2 --worker 0",
    );
  });

  test('a filter with shell punctuation cannot become a second command', () => {
    expect(reproduceFor(shard(1), { workers: 2, filter: 'a; rm -rf b' })).toBe(
      "x test --filter 'a; rm -rf b' --workers 2 --worker 1",
    );
  });

  test('a single quote is escaped the one way a single-quoted string allows', () => {
    // `'it'\''s slow'` — close, an escaped quote, reopen. Anything else truncates the argument.
    expect(reproduceFor(shard(0), { workers: 1, filter: "it's slow" })).toBe(
      "x test --filter 'it'\\''s slow' --workers 1 --worker 0",
    );
  });

  test('quoteArg leaves an ordinary path alone, so the common line stays readable', () => {
    expect(quoteArg('packages/cli/src/cmd-test.test.ts')).toBe('packages/cli/src/cmd-test.test.ts');
    expect(quoteArg('')).toBe("''");
    expect(quoteArg('a b')).toBe("'a b'");
  });
});
