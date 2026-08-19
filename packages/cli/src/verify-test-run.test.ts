// One test type across N worker processes, reported as one gate step. The two things a reader of
// a red gate acts on are asserted here: the shard reproduction (a command that reruns the SAME
// file set, not the whole type) and the fact that only the failing shards' output survives.

import { describe, expect, test } from 'bun:test';
import type { ExecResult, Runner } from './exec';
import type { TestFile } from './test-select';
import { SHARD_COMMAND_PREFIX } from './test-shards';
import { runParallel } from './verify-test-run';

const files = (count: number): readonly TestFile[] =>
  Array.from({ length: count }, (_, index) => ({
    path: `f${index}.test.ts`,
    // Descending sizes, so `planShards` has something to balance rather than a tie to break.
    bytes: (count - index) * 100,
  }));

const summary = (pass: number, fail: number): string =>
  `\n ${pass} pass\n ${fail} fail\n 1 expect() calls\nRan ${pass + fail} tests across 1 file. [9.00ms]`;

/** Fails exactly the shards whose index is in `failing`; everything else is a green run. */
function shardRunner(failing: ReadonlySet<number>): {
  runner: Runner;
  seen: { worker: string | undefined; files: readonly string[] }[];
} {
  const seen: { worker: string | undefined; files: readonly string[] }[] = [];
  const runner: Runner = async (command, options) => {
    const worker = options.env?.['ULTIMATE_TEST_WORKER'];
    seen.push({ worker, files: command.slice(SHARD_COMMAND_PREFIX.length) });
    const failed = failing.has(Number(worker));
    const result: ExecResult = {
      command,
      code: failed ? 1 : 0,
      ok: !failed,
      stdout: failed ? `assertion diff for shard ${worker}${summary(0, 1)}` : summary(2, 0),
      stderr: '',
      durationMs: 11,
    };
    return result;
  };
  return { runner, seen };
}

describe('runParallel', () => {
  test('every shard runs at once, each with its own ULTIMATE_TEST_WORKER', async () => {
    const { runner, seen } = shardRunner(new Set());
    const outcome = await runParallel({
      root: '/app',
      runner,
      files: files(4),
      workers: 4,
      type: 'unit',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.workers).toBe(4);
    expect(seen.map((run) => run.worker).sort()).toEqual(['0', '1', '2', '3']);
    // Every file was handed to exactly one shard.
    expect(seen.flatMap((run) => run.files).sort()).toEqual([
      'f0.test.ts',
      'f1.test.ts',
      'f2.test.ts',
      'f3.test.ts',
    ]);
    expect(outcome.findings).toEqual([]);
    // A green split reports the counts, and drops its output.
    expect(outcome.tests).toEqual({ ran: 8, skipped: 0 });
    expect(outcome.output).toBeUndefined();
  });

  test('a failed shard names its index, its exit code and its file count', async () => {
    const { runner } = shardRunner(new Set([1]));
    const outcome = await runParallel({
      root: '/app',
      runner,
      files: files(4),
      workers: 4,
      type: 'contract',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.findings).toHaveLength(1);
    const finding = outcome.findings[0];
    expect(finding?.code).toBe('X_TEST_SHARD_FAILED');
    expect(finding?.cause).toBe('contract shard 1 of 4 exited 1 (1 file(s))');
    // The reproduction has to carry the type AND the effective width, or the rerun splits a
    // different corpus and runs a different file.
    expect(finding?.fix).toBe('x test contract --workers 4 --worker 1');
    expect(finding?.docs).toBe('https://ultimate.dev/errors/X_TEST_SHARD_FAILED');
  });

  test('only the failing shards’ output survives, headed by the shard index', async () => {
    const { runner } = shardRunner(new Set([0, 2]));
    const outcome = await runParallel({
      root: '/app',
      runner,
      files: files(4),
      workers: 4,
      type: 'unit',
    });
    expect(outcome.findings.map((finding) => finding.cause)).toEqual([
      'unit shard 0 of 4 exited 1 (1 file(s))',
      'unit shard 2 of 4 exited 1 (1 file(s))',
    ]);
    expect(outcome.output).toContain('— shard 0');
    expect(outcome.output).toContain('— shard 2');
    expect(outcome.output).not.toContain('— shard 1');
    expect(outcome.output).toContain('assertion diff for shard 0');
  });

  test('the reported width is the CLAMPED one, so the reproduction is runnable', async () => {
    // Two files can only be a two-way split, however many workers were asked for — and a `fix:`
    // naming `--worker 5` of an 8-way split reruns nothing.
    const { runner, seen } = shardRunner(new Set([1]));
    const outcome = await runParallel({
      root: '/app',
      runner,
      files: files(2),
      workers: 8,
      type: 'unit',
    });
    expect(seen).toHaveLength(2);
    expect(outcome.workers).toBe(2);
    expect(outcome.findings[0]?.cause).toContain('shard 1 of 2');
    expect(outcome.findings[0]?.fix).toBe('x test unit --workers 2 --worker 1');
  });
});
