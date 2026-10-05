// The store a primitive's declared `rateLimit:` is counted in — and the boot check that holds it
// to the deployment's `'shared'` declaration exactly as the pipeline's own store is held.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { RateLimitConfig, RateLimitStore } from './rate-limit';
import { DEFAULT_RATE_LIMIT, memoryRateLimitStore } from './rate-limit';
import {
  adoptRateLimitStore,
  assertInstalledRateLimitScope,
  installedRateLimitStore,
  installRateLimitStore,
  resetRateLimitStore,
} from './rate-limit-installed';

// Process-wide, and another file's server may still hold a frame: every test starts empty.
beforeEach(() => resetRateLimitStore());
afterEach(() => resetRateLimitStore());

const config = (scope: 'process' | 'shared'): RateLimitConfig => ({ ...DEFAULT_RATE_LIMIT, scope });

const shared = (): RateLimitStore => ({ ...memoryRateLimitStore(), scope: 'shared' });

describe('the installed rate-limit store', () => {
  test('defaults to one process’ memory, and is the instance installed afterwards', () => {
    expect(installedRateLimitStore().scope).toBe('process');
    const store = shared();
    installRateLimitStore(store);
    expect(installedRateLimitStore()).toBe(store);
    resetRateLimitStore();
    expect(installedRateLimitStore()).not.toBe(store);
  });

  test('a shared declaration refuses a per-process installed store', () => {
    expect(() => assertInstalledRateLimitScope(config('shared'))).toThrow(
      /X_RATE_LIMIT_NOT_SHARED/,
    );
    installRateLimitStore(shared());
    expect(() => assertInstalledRateLimitScope(config('shared'))).not.toThrow();
  });

  test('a process declaration accepts either', () => {
    expect(() => assertInstalledRateLimitScope(config('process'))).not.toThrow();
  });
});

describe('adopting a store', () => {
  test('frames pop in ANY order, each taking only its own', () => {
    const a = shared();
    const b = shared();
    const undoA = adoptRateLimitStore(a);
    const undoB = adoptRateLimitStore(b);
    undoA();
    // A's stop must not revert the slot under B, which is still serving.
    expect(installedRateLimitStore()).toBe(b);
    undoB();
    expect(installedRateLimitStore().scope).toBe('process');
  });

  test('the same store adopted twice is two frames: one release leaves the other', () => {
    const a = shared();
    const first = adoptRateLimitStore(a);
    adoptRateLimitStore(a);
    first();
    expect(installedRateLimitStore()).toBe(a);
  });

  test('keepChosen never covers a store something already chose', () => {
    const booted = shared();
    installRateLimitStore(booted);
    const undo = adoptRateLimitStore(shared(), { keepChosen: true });
    expect(installedRateLimitStore()).toBe(booted);
    undo();
    expect(installedRateLimitStore()).toBe(booted);
  });

  test('an undo run twice is still one release', () => {
    const a = shared();
    const b = shared();
    adoptRateLimitStore(a);
    const undoB = adoptRateLimitStore(b);
    undoB();
    undoB();
    expect(installedRateLimitStore()).toBe(a);
  });
});
