// `tests.run`'s reader: `bun test`'s own summary parsed back into a `TestRun`, never guessed. Split
// from `mcp-host.test.ts` at its line ceiling; pure, so it needs no host.

import { describe, expect, test } from 'bun:test';
import { parseBunTest } from './mcp-test-output';

// Captured from `bun test` 1.3.x verbatim — a hand-written summary would test the fixture.
const PASSING = `bun test v1.3.14 (0d9b296a)

 12 pass
 0 fail
 28 expect() calls
Ran 12 tests across 1 file. [64.00ms]`;

const FAILING = `bun test v1.3.14 (0d9b296a)

sample.test.ts:
3 | describe('outer group', () => {
7 |   test('fails loudly', () => {
8 |     expect(1).toBe(2);
                  ^
error: expect(received).toBe(expected)

Expected: 2
Received: 1

      at <anonymous> (/tmp/bunfixture/sample.test.ts:8:15)
(fail) outer group > fails loudly [0.24ms]

 1 pass
 1 skip
 1 todo
 1 fail
 2 expect() calls
Ran 4 tests across 1 file. [17.00ms]`;

describe('unit · parseBunTest reads the runner, it does not guess', () => {
  test('a passing run', () => {
    expect(parseBunTest(PASSING, 640)).toEqual({
      passed: 12,
      failed: 0,
      skipped: 0,
      durationMs: 640,
      failures: [],
    });
  });

  test('a failing run names the test and its message', () => {
    const run = parseBunTest(FAILING, 170);
    expect(run.passed).toBe(1);
    expect(run.failed).toBe(1);
    // `skip` and `todo` are both "not run".
    expect(run.skipped).toBe(2);
    expect(run.failures).toEqual([
      { test: 'outer group > fails loudly', message: 'expect(received).toBe(expected)' },
    ]);
  });

  test('output it cannot parse is a FAILED run carrying the tail, never a green zero', () => {
    const run = parseBunTest('bun: command not found\nsegmentation fault', 12);
    expect(run.failed).toBe(1);
    expect(run.passed).toBe(0);
    expect(run.failures[0]?.message).toContain('command not found');
  });

  test('no output at all still fails', () => {
    const run = parseBunTest('', 0);
    expect(run.failed).toBe(1);
    expect(run.failures[0]?.message).toBe('bun test produced no output');
  });
});
