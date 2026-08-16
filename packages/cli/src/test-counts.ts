// What a test step actually executed, read back out of `bun test`'s own summary. Separate from
// the two runners because both of them need it and neither owns it: a step's exit code answers
// "did anything fail", and only the counts answer "did anything run".

import type { ExecResult } from './exec';
import { execOutput } from './exec';
import { parseBunTest } from './mcp-test-output';

export interface TestCounts {
  /** Tests that executed — passed plus failed. A failed test is a test that ran. */
  readonly ran: number;
  /** Tests bun reported as skipped or todo, which is the same thing here: they did not run. */
  readonly skipped: number;
}

/**
 * Summed across every process the step spawned, because a step is one line in the gate whether it
 * ran on one worker or eight.
 *
 * `parseBunTest` is the reader, not a second regex: it is already the one place this repo turns
 * bun's summary into numbers (`x mcp`'s `test.run`), and two readers of one format is exactly the
 * drift the CLI's own boundary rule forbids. It reports output it cannot recognise as one FAILED
 * test rather than as zeros — which is what keeps a runner that died before printing a summary
 * from reading as a suite that ran nothing.
 */
export const countsOf = (results: readonly ExecResult[]): TestCounts => {
  let ran = 0;
  let skipped = 0;
  for (const result of results) {
    const run = parseBunTest(execOutput(result), result.durationMs);
    ran += run.passed + run.failed;
    skipped += run.skipped;
  }
  return { ran, skipped };
};
