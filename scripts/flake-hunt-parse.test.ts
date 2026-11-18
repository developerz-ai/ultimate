// `flake-hunt-parse.ts` over the text `bun test` really prints — captured from Bun 1.4.4 with
// `--randomize`, serial and `--parallel` alike: each `(fail)` line is filed under the file header
// above it, with its timing stripped, and the lines before it kept as the issue's excerpt.

import { describe, expect, test } from 'bun:test';
import { failedTests } from './flake-hunt-parse';

const OUTPUT = [
  'bun test v1.4.4 (38afee6c8) 2x PARALLEL',
  '',
  'packages/core/src/b.test.ts:',
  '(pass) b1 [0.10ms]',
  '',
  'packages/core/src/c.test.ts:',
  'error: expect(received).not.toBe(expected)',
  '',
  'Expected: not "c"',
  '',
  '      at <anonymous> (/repo/packages/core/src/c.test.ts:2:86)',
  '(fail) c2 [0.14ms]',
  '',
  'packages/jobs/src/z.live.test.ts:',
  'error: expect(received).toBe(expected)',
  '(fail) outer > inner > deep > thing [5001.20ms]',
  '  ^ this test timed out after 5000ms.',
  '',
  ' --seed=9',
  ' 5 pass',
  ' 2 fail',
].join('\n');

describe('unit · flake-hunt · failedTests', () => {
  test('each (fail) line is named with the file header above it, timing stripped', () => {
    expect(failedTests(OUTPUT).map(({ file, test }) => ({ file, test }))).toEqual([
      { file: 'packages/core/src/c.test.ts', test: 'c2' },
      { file: 'packages/jobs/src/z.live.test.ts', test: 'outer > inner > deep > thing' },
    ]);
  });

  // What CI prints (compat run 43826824005): `x test` wraps each file in GitHub's `::group::`
  // markers, and a header read only bare named no file — every red part said "0 failing tests".
  test('a header inside a CI ::group:: marker still names the file its failures belong to', () => {
    const ci = [
      '::group::scripts/lib/planned-writes.test.ts:',
      '::error title=error: Test "x" timed out after 5000ms::',
      '(fail) writePlanned > writes every edit [7653.56ms]',
      '',
      '::endgroup::',
    ].join('\n');
    expect(failedTests(ci).map(({ file, test }) => ({ file, test }))).toEqual([
      { file: 'scripts/lib/planned-writes.test.ts', test: 'writePlanned > writes every edit' },
    ]);
  });

  test('the excerpt is the lines since the file header, so the assertion rides in the issue', () => {
    const [first] = failedTests(OUTPUT);
    expect(first?.excerpt).toContain('Expected: not "c"');
    expect(first?.excerpt).not.toContain('b.test.ts');
  });

  test('a green run, or a run that never named a test, has no failures', () => {
    expect(failedTests('packages/a.test.ts:\n(pass) a [1ms]\n 1 pass\n 0 fail')).toEqual([]);
    expect(failedTests('error: Cannot find module "x"\n# Unhandled error between tests')).toEqual(
      [],
    );
  });

  test("bun's end-of-run repeat of the failures is not a second failure in the last file", () => {
    const repeated = `${OUTPUT}\n\n2 tests failed:\n(fail) c2 [0.14ms]\n(fail) outer > inner > deep > thing`;
    expect(failedTests(repeated)).toHaveLength(2);
  });

  // A shard is many `bun test` batches, each ending in its own repeat: the first one must not end
  // the read, or every failure in a later batch goes unnamed (compat run 43826824005, unit-1).
  test('a repeat ends one batch, and the next batch is still read', () => {
    const batches = [
      'packages/a.test.ts:',
      '(fail) first [1ms]',
      '',
      '1 tests failed:',
      '(fail) first [1ms]',
      '── batch 2 of 2 ──',
      'packages/b.test.ts:',
      '(fail) second [1ms]',
      '',
      '1 tests failed:',
      '(fail) second [1ms]',
    ].join('\n');
    expect(failedTests(batches).map(({ file, test }) => ({ file, test }))).toEqual([
      { file: 'packages/a.test.ts', test: 'first' },
      { file: 'packages/b.test.ts', test: 'second' },
    ]);
  });

  test('ANSI colour is stripped before a name is read', () => {
    const coloured =
      'packages/a.test.ts:\n\u001b[31m(fail)\u001b[0m red one \u001b[2m[1ms]\u001b[0m';
    expect(failedTests(coloured).map((one) => one.test)).toEqual(['red one']);
  });
});
