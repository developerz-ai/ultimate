// `x verify --workers N`, from both ends of the bound. Its own file because `cmd-verify.test.ts`
// drives the step engine and this drives one flag reader — and the engine's file is at the line
// ceiling, so a third bound assertion could not have landed beside it.

import { describe, expect, test } from 'bun:test';
import { readWorkers, verifyCommand } from './cmd-verify';
import type { ParsedArgs } from './parse';
import { parseArgs } from './parse';
import { WORKER_CEILING, WORKER_FLOOR } from './test-workers';

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
