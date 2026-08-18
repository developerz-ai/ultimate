// The decision itself, without a queue in the way. The case that matters most is the one that
// looks like a no-op: an UNCLASSIFIED code already carries `retry: 'terminal'` (core fails
// closed), and reading that field alone would stop retrying every job in every shipped app.

import { beforeEach, describe, expect, test } from 'bun:test';
import { registerErrorRetry, UltimateError } from '@ultimat3/core';
import type { RetryPolicy } from './retry';
import {
  classifyThrown,
  nextRetryForError,
  recordedFailure,
  statedDelayMs,
} from './retry-classification';

const policy: RetryPolicy = {
  attempts: 3,
  backoff: 'fixed',
  delay: 1_000,
  maxDelay: 60_000,
  jitter: false,
};

const coded = (
  code: string,
  init?: { retry?: 'terminal' | 'retryable' | 'retry-after'; meta?: Record<string, unknown> },
): UltimateError =>
  new UltimateError({
    code,
    cause: 'the credential was refused',
    fix: 'rotate the credential, then re-enqueue',
    ...(init?.retry === undefined ? {} : { retry: init.retry }),
    ...(init?.meta === undefined ? {} : { meta: init.meta }),
  });

beforeEach(() => {
  registerErrorRetry({
    X_TEST_CLASSIFY_TERMINAL: 'terminal',
    X_TEST_CLASSIFY_RETRYABLE: 'retryable',
    X_TEST_CLASSIFY_AFTER: 'retry-after',
  });
});

describe('classifyThrown', () => {
  test('reads a declared classification, whichever kind', () => {
    expect(classifyThrown(coded('X_TEST_CLASSIFY_TERMINAL'))).toBe('terminal');
    expect(classifyThrown(coded('X_TEST_CLASSIFY_RETRYABLE'))).toBe('retryable');
    expect(classifyThrown(coded('X_TEST_CLASSIFY_AFTER'))).toBe('retry-after');
    // Core's own table, which no app may move.
    expect(classifyThrown(coded('X_TIMEOUT'))).toBe('retryable');
  });

  test('an unclassified code answers undefined, NOT the terminal it carries', () => {
    const error = coded('X_TEST_NOBODY_CLASSIFIED_THIS');

    // The trap, in one assertion: the error says terminal and nobody ever said so.
    expect(error.retry).toBe('terminal');
    expect(classifyThrown(error)).toBeUndefined();
  });

  test('a per-instance override on a DECLARED code is honoured', () => {
    expect(classifyThrown(coded('X_TIMEOUT', { retry: 'terminal' }))).toBe('terminal');
    expect(classifyThrown(coded('X_TEST_CLASSIFY_TERMINAL', { retry: 'retryable' }))).toBe(
      'retryable',
    );
  });

  test('a non-UltimateError has no code, so no classification', () => {
    expect(classifyThrown(new TypeError('undefined is not a function'))).toBeUndefined();
    expect(classifyThrown('a string nobody threw deliberately')).toBeUndefined();
    expect(classifyThrown(undefined)).toBeUndefined();
  });
});

describe('statedDelayMs', () => {
  test('reads retryAfterSeconds, the one spelling the framework writes', () => {
    expect(statedDelayMs(coded('X_TEST_CLASSIFY_AFTER', { meta: { retryAfterSeconds: 30 } }))).toBe(
      30_000,
    );
  });

  test('refuses anything that is not a usable number of seconds', () => {
    expect(statedDelayMs(coded('X_TEST_CLASSIFY_AFTER'))).toBeUndefined();
    expect(
      statedDelayMs(coded('X_TEST_CLASSIFY_AFTER', { meta: { retryAfterSeconds: '30' } })),
    ).toBeUndefined();
    expect(
      statedDelayMs(coded('X_TEST_CLASSIFY_AFTER', { meta: { retryAfterSeconds: -1 } })),
    ).toBeUndefined();
    expect(
      statedDelayMs(coded('X_TEST_CLASSIFY_AFTER', { meta: { retryAfterSeconds: Number.NaN } })),
    ).toBeUndefined();
  });
});

describe('nextRetryForError', () => {
  test('terminal stops on the attempt that failed, with the policy still deciding the park', () => {
    expect(nextRetryForError(policy, 1, coded('X_TEST_CLASSIFY_TERMINAL'))).toEqual({
      retry: false,
      delayMs: 0,
      deadLetter: true,
      nextAttempt: 1,
      stoppedBy: 'terminal',
      classification: 'terminal',
    });
    expect(
      nextRetryForError({ ...policy, deadLetter: false }, 1, coded('X_TEST_CLASSIFY_TERMINAL'))
        .deadLetter,
    ).toBe(false);
  });

  test('retryable and unclassified both take the attempt-count path, identically', () => {
    const classified = nextRetryForError(policy, 1, coded('X_TEST_CLASSIFY_RETRYABLE'));
    const unclassified = nextRetryForError(policy, 1, coded('X_TEST_NOBODY_CLASSIFIED_THIS'));

    expect(classified).toMatchObject({ retry: true, delayMs: 1_000, stoppedBy: undefined });
    expect(unclassified).toMatchObject({ retry: true, delayMs: 1_000, stoppedBy: undefined });
    expect(unclassified.classification).toBeUndefined();
  });

  test('the ceiling wins over every classification that is not terminal', () => {
    for (const code of ['X_TEST_CLASSIFY_RETRYABLE', 'X_TEST_CLASSIFY_AFTER', 'X_UNKNOWN_CODE']) {
      const decision = nextRetryForError(
        policy,
        3,
        coded(code, { meta: { retryAfterSeconds: 5 } }),
      );
      expect(decision).toMatchObject({ retry: false, stoppedBy: 'attempts-exhausted' });
    }
  });

  test('retry-after replaces the delay, clamped by maxDelay, and never the ceiling', () => {
    const named = coded('X_TEST_CLASSIFY_AFTER', { meta: { retryAfterSeconds: 30 } });
    const absurd = coded('X_TEST_CLASSIFY_AFTER', { meta: { retryAfterSeconds: 86_400 } });

    expect(nextRetryForError(policy, 1, named).delayMs).toBe(30_000);
    expect(nextRetryForError(policy, 1, absurd).delayMs).toBe(60_000);
    // Said nothing about when: the policy's own backoff, not a guess of our own.
    expect(nextRetryForError(policy, 1, coded('X_TEST_CLASSIFY_AFTER')).delayMs).toBe(1_000);
  });

  test('a stated delay is ignored on a code that is not retry-after', () => {
    const error = coded('X_TEST_CLASSIFY_RETRYABLE', { meta: { retryAfterSeconds: 30 } });

    expect(nextRetryForError(policy, 1, error).delayMs).toBe(1_000);
  });
});

describe('recordedFailure', () => {
  test('appends the verdict only when the verdict is why the job stopped', () => {
    const terminal = nextRetryForError(policy, 1, coded('X_TEST_CLASSIFY_TERMINAL'));
    const exhausted = nextRetryForError(policy, 3, coded('X_TEST_CLASSIFY_RETRYABLE'));
    const retried = nextRetryForError(policy, 1, coded('X_TEST_CLASSIFY_RETRYABLE'));

    expect(recordedFailure('boom', terminal)).toContain('not retried');
    expect(recordedFailure('boom', terminal).startsWith('boom')).toBe(true);
    expect(recordedFailure('boom', exhausted)).toBe('boom');
    expect(recordedFailure('boom', retried)).toBe('boom');
  });
});
