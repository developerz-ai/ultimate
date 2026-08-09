// Reading `bun test`'s own summary back into a `TestRun`. Separate from the host because it is a
// pure string reader with no services behind it — and because the one thing it must never do,
// report a crashed runner as a green run, is worth pinning on its own.

import type { TestRun } from '@ultimat3/mcp';

const TAIL_LINES = 20;
const FAIL_LINE = /^\(fail\)\s+(.*?)(?:\s+\[[\d.]+\s*m?s\])?$/;
const ERROR_LINE = /^\s*error:\s*(.+)$/;

const lastCount = (output: string, label: string): number | undefined => {
  const last = [...output.matchAll(new RegExp(`^\\s*(\\d+)\\s+${label}\\b`, 'gm'))].at(-1);
  return last === undefined ? undefined : Number.parseInt(last[1] ?? '0', 10);
};

const tailOf = (output: string): string => {
  const lines = output.split('\n').filter((line) => line.trim().length > 0);
  return lines.length === 0 ? 'bun test produced no output' : lines.slice(-TAIL_LINES).join('\n');
};

/**
 * Bun prints its own summary, so this reads it instead of counting anything a second time. Output
 * it cannot recognise is reported as a FAILED run carrying the raw tail: returning zeros there
 * would turn a runner that crashed before it started into a green run.
 */
export function parseBunTest(output: string, durationMs: number): TestRun {
  const passed = lastCount(output, 'pass');
  const failed = lastCount(output, 'fail');
  if (passed === undefined && failed === undefined) {
    const failure = { test: 'bun test', message: tailOf(output) };
    return { passed: 0, failed: 1, skipped: 0, durationMs, failures: [failure] };
  }
  const failures: { test: string; message: string }[] = [];
  let message = '';
  for (const line of output.split('\n')) {
    const error = ERROR_LINE.exec(line);
    if (error !== null) {
      message = error[1] ?? '';
      continue;
    }
    const fail = FAIL_LINE.exec(line.trimEnd());
    if (fail === null) continue;
    failures.push({
      test: (fail[1] ?? '').trim(),
      message: message === '' ? 'no error message in the run output' : message,
    });
    message = '';
  }
  return {
    passed: passed ?? 0,
    failed: failed ?? 0,
    // `skip` and `todo` print on separate lines and both mean "not run".
    skipped: (lastCount(output, 'skip') ?? 0) + (lastCount(output, 'todo') ?? 0),
    durationMs,
    failures,
  };
}
