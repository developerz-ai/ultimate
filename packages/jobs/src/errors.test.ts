// Every code jobs declares must carry a title, be registered after import, and document at the
// standard URL — the same contract `x errors explain <CODE>` relies on for every package.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, ERROR_DOCS_URL, hasErrorCode } from '@ultimat3/core';
import { BackfillPendingError } from './backfill-errors';
import {
  JOB_BORROWED_ERROR_CODES,
  JOB_ERROR_CODES,
  JOB_ERROR_TITLES,
  JOB_OWNED_ERROR_CODES,
} from './error-codes';
import {
  CancelUnsupportedError,
  JobDuplicateError,
  JobMaxAttemptsError,
  StepDuplicateError,
} from './errors';

describe('job error titles', () => {
  test('titles exactly the codes jobs owns — a borrowed code carries no title here', () => {
    expect(Object.keys(JOB_ERROR_TITLES).sort()).toEqual([...JOB_OWNED_ERROR_CODES].sort());
  });

  test('owned and borrowed are disjoint and together are every code jobs throws', () => {
    const owned = new Set<string>(JOB_OWNED_ERROR_CODES);
    for (const code of JOB_BORROWED_ERROR_CODES) expect(owned.has(code)).toBe(false);
    expect([...JOB_ERROR_CODES].sort()).toEqual(
      [...JOB_OWNED_ERROR_CODES, ...JOB_BORROWED_ERROR_CODES].sort(),
    );
  });

  test('every owned code is registered with its declared title after import', () => {
    for (const code of JOB_OWNED_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(JOB_ERROR_TITLES[code]);
    }
  });

  test('every borrowed code is registered by its owner, with a title jobs never wrote', () => {
    for (const code of JOB_BORROWED_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title.length).toBeGreaterThan(0);
    }
  });

  test('every code documents at the standard docs URL', () => {
    // Core's constant, never a copy of the string: one URL for every code, declared once.
    for (const code of JOB_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(ERROR_DOCS_URL);
    }
  });

  // The registry test above passed the whole time a `docsFor(code)` here was overriding `docs:`
  // on every instance with `https://ultimate.dev/errors/<code>`, a host that answers 404: a
  // registry read cannot see what a CONSTRUCTOR puts on the error, and the instance is what lands
  // in a dead-letter row and in `x jobs show --json`. Both files that throw are covered, because
  // `backfill-errors.ts` imported that helper too.
  test('a constructed job error carries it too, not a per-code url', () => {
    const errors = [
      new JobDuplicateError({ job: 'sendDigest', idempotencyKey: 'u1', existingId: 'j1' }),
      new StepDuplicateError({ job: 'sendDigest', step: 'charge' }),
      new BackfillPendingError({ backfill: 'backfillSlugs', environment: 'production' }),
    ];
    for (const error of errors) {
      expect(error.docs).toBe(ERROR_DOCS_URL);
      expect(error.docs).not.toContain(error.code);
      expect(error.docs).not.toContain('ultimate.dev');
    }
  });
});

describe('the two refusals only an operator verb meets', () => {
  test('retries spent name the retry command for that job id', () => {
    const error = new JobMaxAttemptsError({
      job: 'sendDigest',
      jobId: 'j-7',
      attempts: 3,
      lastError: 'smtp 421',
    });
    expect(error.code).toBe('X_JOB_MAX_ATTEMPTS');
    expect(error.cause).toBe('job "sendDigest" failed 3 times, last error: smtp 421');
    expect(error.fix).toBe('x jobs retry j-7');
  });

  test('a driver with no cancel names the driver and the one that has it', () => {
    const error = new CancelUnsupportedError({ driver: 'redis' });
    expect(error.code).toBe('X_JOB_NOT_CANCELLABLE');
    expect(error.cause).toContain('"redis"');
    expect(error.fix).toContain('setJobDriver(postgresJobDriver())');
  });
});
