// What a finished `x test` run says beyond its exit code: which files failed, read out of bun's own
// per-file headers, and the finding for a run in which every test skipped itself.

import { describe, expect, test } from 'bun:test';
import { TEST_SERVICES_START } from '@ultimat3/testing';
import { allSkippedFinding, failingFiles } from './test-verdict';

/** Bun 1.4's own output, `--parallel=2`, one failing file, one load error, one that only logged. */
const BUN_OUTPUT = [
  'bun test v1.4.4 (38afee6c8) 2x PARALLEL',
  '',
  'apps/web/a.test.ts:',
  'error: expect(received).toBe(expected)',
  '',
  '(fail) a bad [0.08ms]',
  '',
  'apps/web/d.test.ts:',
  'hello',
  '',
  'apps/web/c.test.ts:',
  '',
  '# Unhandled error between tests',
  'error: load boom',
  '',
  ' 2 pass',
  ' 2 fail',
  'Ran 5 tests across 4 files. [26.00ms]',
].join('\n');

const FILES = [
  'apps/web/a.test.ts',
  'apps/web/b.test.ts',
  'apps/web/c.test.ts',
  'apps/web/d.test.ts',
];

describe('unit · failingFiles', () => {
  test('names each file whose section holds a failure, not one that only logged', () => {
    expect(failingFiles(BUN_OUTPUT, FILES)).toEqual(['apps/web/a.test.ts', 'apps/web/c.test.ts']);
  });

  test('a header naming no file of the run is not a file', () => {
    expect(failingFiles('other.ts:\n(fail) x\n', FILES)).toEqual([]);
  });

  test('a run that printed no header names nothing', () => {
    expect(failingFiles('ran', FILES)).toEqual([]);
  });
});

describe('unit · allSkippedFinding', () => {
  test('a service variable the children lack is named, and the fix starts the services first', () => {
    const finding = allSkippedFinding({
      type: 'live',
      skipped: 3,
      files: ['apps/web/a.live.test.ts'],
      env: {},
      rerun: 'x test live --workers 1',
    });
    expect(finding.code).toBe('X_TEST_FAILED');
    expect(finding.cause).toContain('0 of 3');
    expect(finding.cause).toContain('TEST_DATABASE_URL');
    expect(finding.fix).toStartWith(`${TEST_SERVICES_START} && x test live   # `);
  });

  test('every service set: the fix shows each skip condition in the files that ran', () => {
    const finding = allSkippedFinding({
      skipped: 1,
      files: ['apps/web/a.test.ts'],
      env: {
        TEST_DATABASE_URL: 'postgres://x',
        TEST_REDIS_URL: 'redis://x',
        TEST_NATS_URL: 'nats://x',
      },
      rerun: 'x test --workers 1',
    });
    expect(finding.cause).not.toContain('TEST_DATABASE_URL');
    expect(finding.fix.startsWith('grep -nE ')).toBe(true);
    expect(finding.fix).toContain('apps/web/a.test.ts');
  });
});

test('unit · an untyped, filtered run reruns its own filter once the services are up', () => {
  const finding = allSkippedFinding({
    filter: 'apps/web/',
    skipped: 1,
    files: ['apps/web/a.test.ts'],
    env: {},
    rerun: 'x test --filter apps/web/ --workers 1',
  });
  expect(finding.fix).toStartWith(`${TEST_SERVICES_START} && x test --filter apps/web/   # `);
});
