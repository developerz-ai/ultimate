// The store a primitive's declared `rateLimit:` is counted in — and the boot check that holds it
// to the deployment's `'shared'` declaration exactly as the pipeline's own store is held.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { RateLimitConfig, RateLimitStore } from './rate-limit';
import { memoryRateLimitStore } from './rate-limit';
import { DEFAULT_RATE_LIMIT } from './rate-limit-config';
import {
  assertInstalledRateLimitScope,
  clearDefaultRateLimitBuckets,
  installedRateLimitStore,
  installRateLimitStore,
  resetRateLimitStore,
  withScratchRateLimitStore,
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
    const release = installRateLimitStore(store);
    expect(installedRateLimitStore()).toBe(store);
    release();
    expect(installedRateLimitStore().scope).toBe('process');
    installRateLimitStore(store);
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

describe('installing a store', () => {
  test('frames pop in ANY order, each taking only its own', () => {
    const a = shared();
    const b = shared();
    const undoA = installRateLimitStore(a);
    const undoB = installRateLimitStore(b);
    undoA();
    // A's stop must not revert the slot under B, which is still serving.
    expect(installedRateLimitStore()).toBe(b);
    undoB();
    expect(installedRateLimitStore().scope).toBe('process');
  });

  test('the same store adopted twice is two frames: one release leaves the other', () => {
    const a = shared();
    const first = installRateLimitStore(a);
    installRateLimitStore(a);
    first();
    expect(installedRateLimitStore()).toBe(a);
  });

  test('an undo run twice is still one release', () => {
    const a = shared();
    const b = shared();
    installRateLimitStore(a);
    const undoB = installRateLimitStore(b);
    undoB();
    undoB();
    expect(installedRateLimitStore()).toBe(a);
  });
});

describe('withScratchRateLimitStore', () => {
  const BUCKET = { capacity: 1, refillPerSecond: 0.0001 };

  test("a spend inside is the scratch's: the installed bucket is full after, the slot restored", async () => {
    const store = shared();
    installRateLimitStore(store);
    const inside = await withScratchRateLimitStore(async () => {
      expect(installedRateLimitStore()).not.toBe(store);
      // The declaration is still judged against what the app installed.
      expect(installedRateLimitStore().scope).toBe('shared');
      return installedRateLimitStore().take('k', BUCKET, 1, 1_700_000_000_000);
    });
    expect(inside.allowed).toBe(true);
    expect(installedRateLimitStore()).toBe(store);
    expect((await store.take('k', BUCKET, 1, 1_700_000_000_000)).allowed).toBe(true);
  });

  test('a throw inside still restores the slot', async () => {
    const store = installedRateLimitStore();
    const thrown = new TypeError('the exercise broke');
    await expect(withScratchRateLimitStore(() => Promise.reject(thrown))).rejects.toBe(thrown);
    expect(installedRateLimitStore()).toBe(store);
  });
});

describe('clearDefaultRateLimitBuckets', () => {
  const BUCKET = { capacity: 1, refillPerSecond: 0.0001 };
  const AT = 1_700_000_000_000;

  test('empties the default memory buckets, so the next test starts full', async () => {
    expect((await installedRateLimitStore().take('k', BUCKET, 1, AT)).allowed).toBe(true);
    expect((await installedRateLimitStore().take('k', BUCKET, 1, AT)).allowed).toBe(false);
    clearDefaultRateLimitBuckets();
    expect((await installedRateLimitStore().take('k', BUCKET, 1, AT)).allowed).toBe(true);
  });

  test('leaves a store a suite installed in place — a live Redis/Postgres suite stays on it', () => {
    const installed = shared();
    installRateLimitStore(installed);
    clearDefaultRateLimitBuckets();
    expect(installedRateLimitStore()).toBe(installed);
  });
});
