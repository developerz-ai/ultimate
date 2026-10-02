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
  /**
   * Errors raised OUTSIDE any test — a `describe` body or a module that threw on load, a failed
   * hook — which bun counts on a line of their own (`1 error`) beside `0 fail`. Present only when
   * there were some: the exit code already makes the step red, and without this number the step
   * line read "12 ran, 0 skipped" over a run whose file never got as far as declaring a test.
   */
  readonly errors?: number;
}

/** Bun's own `N error` / `N errors` summary line: the last one, as `parseBunTest` reads the rest. */
const errorsIn = (output: string): number => {
  const last = [...output.matchAll(/^\s*(\d+)\s+errors?\s*$/gm)].at(-1);
  return last === undefined ? 0 : Number.parseInt(last[1] ?? '0', 10);
};

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
  let errors = 0;
  for (const result of results) {
    const output = execOutput(result);
    const run = parseBunTest(output, result.durationMs);
    ran += run.passed + run.failed;
    skipped += run.skipped;
    errors += errorsIn(output);
  }
  return { ran, skipped, ...(errors === 0 ? {} : { errors }) };
};
