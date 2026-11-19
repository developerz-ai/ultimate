// `x verify --workers N`, from both ends of the bound. Its own file because `cmd-verify.test.ts`
// drives the step engine and this drives one flag reader — and the engine's file is at the line
// ceiling, so a third bound assertion could not have landed beside it.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no `Bun.*` equivalent for either: `mkdtemp`/`rm` own a throwaway root's lifetime.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { readWorkers, verifyCommand } from './cmd-verify';
import type { Runner } from './exec';
import type { ParsedArgs } from './parse';
import { parseArgs } from './parse';
import { availableCpus, WORKER_CEILING, WORKER_FLOOR } from './test-workers';
import { bareTestStep, resetTestDiscovery } from './verify-tests';

const args = (value: string): ParsedArgs =>
  parseArgs(['verify', '--workers', value], [verifyCommand.spec]);

/** `toThrow(Class)` passes in Bun 1.4.0 when the callee merely RETURNS an error. */
const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('unit · x verify --workers', () => {
  // The bug this guards: the summary said "max 8" and `readWorkers` passed no `max`, so
  // `--workers 5000` was accepted and every parallel step spawned one Bun process per test file.
  test('--workers is bounded by the ceiling the summary names', () => {
    expect(readWorkers(args(String(WORKER_CEILING)))).toBe(WORKER_CEILING);
    expect(readWorkers(parseArgs(['verify'], [verifyCommand.spec]))).toBeUndefined();
    expect(thrownBy(() => readWorkers(args(String(WORKER_CEILING + 1))))).toMatchObject({
      code: 'X_CLI_BAD_FLAG',
      fix: 'x verify --workers 4',
    });
  });

  // The same defect at the other end, and the one that makes `WORKER_FLOOR` load-bearing rather
  // than decorative: the flag summary named the constant while the reader passed a literal 1, so
  // `x verify --workers 1` ran the gate serially against help text that said the minimum was 2.
  test('--workers is bounded by the floor the summary names', () => {
    expect(readWorkers(args(String(WORKER_FLOOR)))).toBe(WORKER_FLOOR);
    expect(thrownBy(() => readWorkers(args(String(WORKER_FLOOR - 1))))).toMatchObject({
      code: 'X_CLI_BAD_FLAG',
      fix: 'x verify --workers 4',
    });
  });

  // `x help verify` derives from the spec, and `cpus - 1` is the default `test-workers.ts`
  // measured and rejected — slower than not sharding at all.
  test('the flag summary names the bounds the reader actually enforces', () => {
    const summary = verifyCommand.spec.flags?.[0]?.summary ?? '';
    expect(summary).not.toContain('CPUs - 1');
    expect(summary).toContain(`min ${WORKER_FLOOR}`);
    expect(summary).toContain(`max ${WORKER_CEILING}`);
  });
});

describe('unit · the width a step names', () => {
  // A plan of several workers over one file: `1 of 6 workers` read like a machine limit.
  test.skipIf(availableCpus() < 2)('fewer files than the plan is one worker per file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-verify-width-'));
    try {
      resetTestDiscovery();
      await Bun.write(join(root, 'packages/db/src/orders.contract.test.ts'), '');
      const runner: Runner = async (command) => ({
        command,
        ok: true,
        code: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
      });
      const outcome = await bareTestStep('contract').run({
        root,
        runner,
        env: { ULTIMATE_TEST_MEMORY_BUDGET: '8g', ULTIMATE_TEST_SLOTS: '0' },
      });
      expect(outcome.widthReason).toStartWith('1 worker, one per file (plan: ');
    } finally {
      resetTestDiscovery();
      await rm(root, { recursive: true, force: true });
    }
  });
});
