import { expect, test } from 'bun:test';
import type { ExecResult } from './exec';
import { countsOf } from './test-counts';

const result = (stderr: string, code = 0): ExecResult => ({
  command: ['bun', 'test'],
  code,
  ok: code === 0,
  stdout: '',
  stderr,
  durationMs: 1,
});

// Verbatim from `bun test` 1.4.0 over one file whose `describe` body throws and one green file.
const ERRORED = [
  '# Unhandled error between tests',
  'TypeError: describe body threw',
  '',
  ' 1 pass',
  ' 0 fail',
  ' 1 error',
  ' 1 expect() calls',
  'Ran 1 test across 2 files. [55.00ms]',
].join('\n');

test('an error outside any test is counted — "0 fail" beside it is not the whole story', () => {
  expect(countsOf([result(ERRORED, 1)])).toEqual({ ran: 1, skipped: 0, errors: 1 });
});

test('summed across processes, and absent from a run that had none', () => {
  const green = ' 3 pass\n 1 skip\n 0 fail\nRan 4 tests across 2 files. [9.00ms]';
  expect(countsOf([result(green)])).toEqual({ ran: 3, skipped: 1 });
  expect(
    countsOf([result(ERRORED, 1), result(green), result(' 2 pass\n 0 fail\n 2 errors', 1)]),
  ).toEqual({ ran: 6, skipped: 1, errors: 3 });
});

test('an "error:" line in a failure’s own output is not the summary count', () => {
  const failed = 'error: expect(received).toBe(expected)\n(fail) a > b\n\n 0 pass\n 1 fail';
  expect(countsOf([result(failed, 1)])).toEqual({ ran: 1, skipped: 0 });
});
