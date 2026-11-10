// The KDF gate's width is a property of the MACHINE, installed by a boot through
// `@ultimat3/auth/adapter`'s `installKdfGate` — with a release, never a `configure*` on the barrel.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import * as adapter from './adapter-subpath';
import * as barrel from './index';
import { installKdfGate, kdfGate, resetKdfGate } from './kdf-gate';

afterEach(() => resetKdfGate());

const shedCode = async (): Promise<string> =>
  kdfGate()
    .run(async () => 'hashed')
    .then(
      (value) => value,
      (error: unknown) => (isUltimateError(error) ? error.code : 'other'),
    );

describe('unit · installKdfGate', () => {
  test('an installed gate is the one every hash passes, and its release restores the default', async () => {
    const release = installKdfGate({ maxConcurrent: 0, maxQueued: 0 });
    expect(await shedCode()).toBe('X_OVERLOADED');
    release();
    expect(await shedCode()).toBe('hashed');
  });

  test('releases stop in any order: the newer install stands until its own release', async () => {
    const releaseWide = installKdfGate({ maxConcurrent: 4, maxQueued: 4 });
    const releaseShut = installKdfGate({ maxConcurrent: 0, maxQueued: 0 });
    releaseWide();
    expect(await shedCode()).toBe('X_OVERLOADED');
    releaseShut();
    expect(await shedCode()).toBe('hashed');
  });

  test('limits are screened at install, before any frame is pushed', () => {
    expect(() => installKdfGate({ maxConcurrent: Number.NaN, maxQueued: 0 })).toThrow();
  });

  test('on ./adapter only — configureKdfGate is gone from the barrel', () => {
    expect(adapter.installKdfGate).toBe(installKdfGate);
    expect(adapter.resetKdfGate).toBe(resetKdfGate);
    const exported = Object.keys(barrel);
    for (const gone of ['configureKdfGate', 'installKdfGate', 'resetKdfGate']) {
      expect([gone, exported.includes(gone)]).toEqual([gone, false]);
    }
  });
});
