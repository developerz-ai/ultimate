// One test type as one gate step. The two things a reader of a red gate acts on are asserted here:
// the reproduction (a command that reruns the same selection, never a different one) and the fact
// that a green run contributes no output while a red one carries the assertion diff.
//
// The per-shard cases this file used to hold are gone with the packer: `bun test --parallel=N`
// hands each free worker the next file, so there is no shard index for a gate step to name and no
// partition of ours for a test to assert. `test-shards.ts`'s header carries what that measured.

import { describe, expect, test } from 'bun:test';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { ExecResult, Runner } from './exec';
import type { TestFile } from './test-select';
import { filesIn } from './test-shards';
import { runParallel } from './verify-test-run';

const files = (count: number): readonly TestFile[] =>
  Array.from({ length: count }, (_, index) => ({
    path: `f${index}.test.ts`,
    bytes: (count - index) * 100,
  }));

const summary = (pass: number, fail: number): string =>
  `\n ${pass} pass\n ${fail} fail\n 1 expect() calls\nRan ${pass + fail} tests across 1 file. [9.00ms]`;

function testRunner(fails: boolean): {
  runner: Runner;
  seen: { command: readonly string[]; env: Record<string, string> | undefined }[];
} {
  const seen: { command: readonly string[]; env: Record<string, string> | undefined }[] = [];
  const runner: Runner = async (command, options) => {
    seen.push({ command, env: options.env });
    const result: ExecResult = {
      command,
      code: fails ? 1 : 0,
      ok: !fails,
      stdout: fails ? `assertion diff${summary(0, 1)}` : summary(2, 0),
      stderr: '',
      durationMs: 11,
    };
    return result;
  };
  return { runner, seen };
}

describe('runParallel', () => {
  test('one run carries every selected file, at the asked width', async () => {
    const { runner, seen } = testRunner(false);
    const outcome = await runParallel({
      root: '/app',
      runner,
      files: files(12),
      workers: 4,
      type: 'unit',
    });

    expect(seen.length).toBe(1);
    expect(seen[0]?.command).toContain('--parallel=4');
    expect(filesIn(seen[0]?.command ?? [])).toEqual([...files(12).map((f) => f.path)].sort());
    expect(outcome.ok).toBe(true);
    expect(outcome.workers).toBe(4);
  });

  // The database is per WORKER and Bun owns the workers now: it numbers each real process with
  // `BUN_TEST_WORKER_ID`, which `@ultimat3/testing`'s `workerId` reads. Exporting
  // `ULTIMATE_TEST_WORKER` here — that function's FIRST key — would pin all N of them to one
  // database, which is the numbered-test-database design silently switched off.
  test('nothing pins every worker to one database', async () => {
    const { runner, seen } = testRunner(false);
    await runParallel({ root: '/app', runner, files: files(6), workers: 3, type: 'unit' });
    expect(seen[0]?.env?.['ULTIMATE_TEST_WORKER']).toBeUndefined();
  });

  test('a failure names the type, the exit code, the width and the file count', async () => {
    const { runner } = testRunner(true);
    const outcome = await runParallel({
      root: '/app',
      runner,
      files: files(9),
      workers: 3,
      type: 'contract',
    });

    expect(outcome.ok).toBe(false);
    const finding = outcome.findings[0];
    expect(finding?.code).toBe('X_TEST_FAILED');
    expect(finding?.cause).toContain('contract run exited 1 across 3 worker(s) (9 file(s))');
    expect(finding?.fix).toBe('x test contract --workers 3');
    expect(finding?.docs).toBe(ERROR_DOCS_URL);
  });

  test('a green run contributes no output, and a red one carries the diff', async () => {
    const green = await runParallel({
      root: '/app',
      runner: testRunner(false).runner,
      files: files(4),
      workers: 2,
      type: 'unit',
    });
    expect(green.output).toBeUndefined();

    const red = await runParallel({
      root: '/app',
      runner: testRunner(true).runner,
      files: files(4),
      workers: 2,
      type: 'unit',
    });
    expect(red.output).toContain('assertion diff');
  });

  // The counts are how the suite ratchet tells a step that ran from one that skipped itself to
  // nothing (`X_VERIFY_SUITE_VANISHED`), so they have to survive the change of runner shape.
  test('the run summary is read back, so the suite ratchet still has counts', async () => {
    const outcome = await runParallel({
      root: '/app',
      runner: testRunner(false).runner,
      files: files(4),
      workers: 2,
      type: 'unit',
    });
    expect(outcome.tests?.ran).toBe(2);
  });

  test('the reported width is the CLAMPED one, so the reproduction is runnable', async () => {
    const { runner, seen } = testRunner(true);
    const outcome = await runParallel({
      root: '/app',
      runner,
      files: files(2),
      workers: 8,
      type: 'unit',
    });
    expect(outcome.workers).toBe(2);
    expect(seen[0]?.command).toContain('--parallel=2');
    expect(outcome.findings[0]?.fix).toBe('x test unit --workers 2');
  });
});
