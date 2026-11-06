// The three `X_REPRO_*` refusals as `x repro` raises them: each names the id it was asked about,
// and `X_REPRO_NOT_REPRODUCED` says what the written test ended in, what was masked and the build.

import { describe, expect, test } from 'bun:test';
import { ReproCaptureOffError, ReproNotReproducedError, ReproUnknownError } from './repro-errors';

describe('x repro refusals', () => {
  test('an id nothing holds is X_REPRO_UNKNOWN, and the fix lists what is held', () => {
    const error = new ReproUnknownError({ id: 'req-9' });
    expect([error.code, error.fix]).toEqual(['X_REPRO_UNKNOWN', 'x repro --list --json']);
    expect(error.cause).toContain('"req-9"');
    expect(error.meta).toEqual({ id: 'req-9' });
  });

  test('capture off is its own code, pointing at the job list and the config switch', () => {
    const error = new ReproCaptureOffError({ id: 'req-9' });
    expect(error.code).toBe('X_REPRO_CAPTURE_OFF');
    expect(error.cause).toContain('failureCapture is disabled');
    expect(error.fix).toStartWith('x jobs list --json');
  });

  test('a pass with nothing masked and no build reads as such', () => {
    const error = new ReproNotReproducedError({
      id: 'abc',
      expected: 'X_PLANTED',
      got: null,
      masked: [],
      file: 'repro/repro-abc.job.test.ts',
      build: null,
    });
    expect(error.code).toBe('X_REPRO_NOT_REPRODUCED');
    expect(error.cause).toBe(
      'repro/repro-abc.job.test.ts ended in a pass, not X_PLANTED; masked fields: none; captured on build unknown',
    );
    expect(error.fix).toStartWith('x repro abc --json, then');
    expect(error.fix).toContain('repro/repro-abc.job.test.ts');
  });

  test('another code, the masked fields and the build are each named', () => {
    const error = new ReproNotReproducedError({
      id: 'abc',
      expected: 'X_PLANTED',
      got: 'X_OTHER',
      masked: ['apiKey', 'card'],
      file: 'repro/x.test.ts',
      build: 'b-7',
    });
    expect(error.cause).toBe(
      'repro/x.test.ts ended in X_OTHER, not X_PLANTED; masked fields: apiKey, card; captured on build b-7',
    );
    expect(error.meta).toMatchObject({ got: 'X_OTHER', masked: ['apiKey', 'card'] });
  });
});
