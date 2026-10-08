// The retiring flag: set the moment a worker's retire begins (SIGUSR2, `@ultimat3/cli`), true for
// the rest of the process, and independent of `isDraining()` — which still flips only at the drain.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  drain,
  isDraining,
  isRetiring,
  lifecycleState,
  markReady,
  markRetiring,
  readyzPayload,
  resetLifecycle,
} from './lifecycle';

beforeEach(() => {
  resetLifecycle();
});

afterEach(() => {
  resetLifecycle();
});

describe('unit · isRetiring', () => {
  test('false until a retire begins', () => {
    expect(isRetiring()).toBe(false);
    markReady();
    expect(isRetiring()).toBe(false);
  });

  test('a retire is not a drain: state, readiness and isDraining are untouched', () => {
    markReady();
    markRetiring();
    expect(isRetiring()).toBe(true);
    expect(isDraining()).toBe(false);
    expect(lifecycleState()).toBe('ready');
    expect(readyzPayload().status).toBe(200);
  });

  test('one-way: idempotent, and still true through and after the drain', async () => {
    markReady();
    markRetiring();
    markRetiring();
    const drained = drain('SIGUSR2');
    expect(isRetiring()).toBe(true);
    expect(isDraining()).toBe(true);
    await drained;
    expect(lifecycleState()).toBe('stopped');
    expect(isRetiring()).toBe(true);
  });

  test('a drain with no retire never reports retiring', async () => {
    markReady();
    await drain('SIGTERM');
    expect(isRetiring()).toBe(false);
  });

  test('resetLifecycle forgets it', () => {
    markRetiring();
    resetLifecycle();
    expect(isRetiring()).toBe(false);
  });
});
