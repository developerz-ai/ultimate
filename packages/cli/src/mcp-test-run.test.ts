// `test.run` folds what `parseBunTest` cannot see: errors outside any test, and the exit code.

import { describe, expect, test } from 'bun:test';
import type { ExecResult } from './exec';
import { errorsIn, testRunOf } from './mcp-test-run';

const result = (stdout: string, code: number): ExecResult => ({
  command: ['bun', 'test'],
  code,
  ok: code === 0,
  stdout,
  stderr: '',
  durationMs: 3,
});

describe('unit · a red bun test is never failed: 0', () => {
  test('one error outside any test is one failure, beside 0 fail', () => {
    const run = testRunOf(result(' 2 pass\n 0 fail\n 1 error\n', 1));
    expect(run.passed).toBe(2);
    expect(run.failed).toBe(1);
    expect(run.failures.map((failure) => failure.test)).toEqual(['bun test']);
  });

  test('a non-zero exit with no failure counted is a failure, naming the exit code', () => {
    const run = testRunOf(result(' 3 pass\n 0 fail\n', 2));
    expect(run.failed).toBe(1);
    expect(run.failures[0]?.message).toContain('exited 2');
  });

  test('a clean run stays clean, and a counted failure is not counted twice', () => {
    expect(testRunOf(result(' 3 pass\n 0 fail\n', 0)).failed).toBe(0);
    const failing = testRunOf(result('(fail) a > b\n 1 pass\n 1 fail\n', 1));
    expect(failing.failed).toBe(1);
    expect(failing.failures.map((failure) => failure.test)).toEqual(['a > b']);
  });

  test('the errors line is read as bun prints it, singular and plural, last one wins', () => {
    expect(errorsIn(' 1 error\n')).toBe(1);
    expect(errorsIn(' 1 error\n 4 errors\n')).toBe(4);
    expect(errorsIn('1 error in the message text\n 0 fail\n')).toBe(0);
  });
});
