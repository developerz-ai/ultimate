// A step's ceiling, both ways a body ends before it: a value passes through and a rejection is the
// body's own, with no abort; and a body past the ceiling is aborted with the error it rejects with.

import { describe, expect, test } from 'bun:test';
import { withStepTimeout } from './steps-timeout';

const never = (): Error => expect.unreachable('the ceiling fired');

describe('withStepTimeout', () => {
  test('a body that rejects first is rejected with its own error, and nothing is aborted', async () => {
    const deadline = new AbortController();
    const own = new TypeError('the body failed');
    let caught: unknown;
    try {
      await withStepTimeout(Promise.reject(own), 60_000, deadline, never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(own);
    expect(deadline.signal.aborted).toBe(false);
  });

  test('a body that resolves first answers its value, and nothing is aborted', async () => {
    const deadline = new AbortController();
    expect(await withStepTimeout(Promise.resolve(7), 60_000, deadline, never)).toBe(7);
    expect(deadline.signal.aborted).toBe(false);
  });

  test('a body past the ceiling aborts, then rejects, with the ceiling error', async () => {
    const deadline = new AbortController();
    const ceiling = new RangeError('step past its ceiling');
    let caught: unknown;
    try {
      await withStepTimeout(new Promise<never>(() => undefined), 1, deadline, () => ceiling);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(ceiling);
    expect(deadline.signal.reason).toBe(ceiling);
  });
});
