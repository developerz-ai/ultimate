// `test.run`'s answer from the whole `bun test` result, not from its pass/fail lines alone: bun
// counts an error raised OUTSIDE any test on a line of its own (`1 error`) beside `0 fail`, and
// says the run failed only through its exit code.

import type { TestRun } from '@ultimat3/mcp';
import type { ExecResult } from './exec';
import { execOutput } from './exec';
import { parseBunTest } from './mcp-test-output';

/** Bun's own `N error` / `N errors` summary line: the last one, as `parseBunTest` reads the rest. */
export const errorsIn = (output: string): number => {
  const last = [...output.matchAll(/^\s*(\d+)\s+errors?\s*$/gm)].at(-1);
  return last === undefined ? 0 : Number.parseInt(last[1] ?? '0', 10);
};

/**
 * Every error outside a test is one failure, carried with the run's own message; a non-zero exit
 * with nothing else counted is one more, so a red process can never answer `failed: 0`.
 */
export function testRunOf(result: ExecResult): TestRun {
  const output = execOutput(result);
  const run = parseBunTest(output, result.durationMs);
  const errors = errorsIn(output);
  const outside = Array.from({ length: errors }, () => ({
    test: 'bun test',
    message: 'an error outside any test — a file that threw while loading, or a failed hook',
  }));
  const counted = run.failed + errors;
  const exitOnly =
    result.code !== 0 && counted === 0
      ? [{ test: 'bun test', message: `bun test exited ${String(result.code)} with no failure` }]
      : [];
  return {
    ...run,
    failed: counted + exitOnly.length,
    failures: [...run.failures, ...outside, ...exitOnly],
  };
}
