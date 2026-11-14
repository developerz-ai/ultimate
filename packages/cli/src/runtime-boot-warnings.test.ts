// The boot's half of core's `bootWarning`: the booting roles and the per-build marker store are
// installed once, the store writes the retained-assets marker layout, and the release restores.

import { afterEach, describe, expect, test } from 'bun:test';
import { bootWarning, resetBootWarnings } from '@ultimat3/core';
import { defineStorage, memoryStorageDriver } from '@ultimat3/storage';
import { retainedPrefix } from './retained-assets-layout';
import { warnedPrefix } from './retained-assets-warned';
import { installRoleBootWarnings, retainedBuildOnce } from './runtime-boot-warnings';

afterEach(resetBootWarnings);

const recorder = () => {
  const codes: unknown[] = [];
  return {
    codes,
    log: {
      warn: (_: string, fields: Readonly<Record<string, unknown>>) => codes.push(fields['code']),
    },
  };
};

const SPEC = { code: 'X_APP_LOCAL_INDEX', roles: ['worker'], once: 'build', message: 'm' } as const;

describe('unit · runtime-boot-warnings', () => {
  test('installs the booting roles and a build store on the shared disk; the release restores', async () => {
    const disk = memoryStorageDriver();
    const storage = defineStorage({ disks: { assets: disk } });
    const release = installRoleBootWarnings({
      roles: ['worker', 'scheduler'],
      config: { name: 'app' },
      storage,
      env: { ULTIMATE_ENV: 'staging' },
      buildId: 'b1',
    });
    const { codes, log } = recorder();
    try {
      expect(await bootWarning(SPEC, { log })).toBe(true);
      expect(await bootWarning(SPEC, { log })).toBe(false);
      expect(await bootWarning({ ...SPEC, roles: ['web'] }, { log })).toBe(false);
      const prefix = retainedPrefix('app', 'staging');
      expect([...disk.objects().keys()]).toEqual([
        `${warnedPrefix(prefix, 'worker~X_APP_LOCAL_INDEX')}b1`,
      ]);
    } finally {
      release();
    }
    expect(codes).toEqual(['X_APP_LOCAL_INDEX']);
    // Released: no store, so `build` is once per process again — and this process has not said it.
    expect(await bootWarning(SPEC, { roles: ['worker'], log })).toBe(true);
  });

  test('with no app config there is no scope to mark under: build is once per process', async () => {
    const storage = defineStorage({ disks: { assets: memoryStorageDriver() } });
    const release = installRoleBootWarnings({
      roles: ['worker'],
      config: undefined,
      storage,
      env: {},
      buildId: 'b1',
    });
    const { codes, log } = recorder();
    try {
      await bootWarning(SPEC, { log });
      await bootWarning(SPEC, { log });
    } finally {
      release();
    }
    expect(codes).toEqual(['X_APP_LOCAL_INDEX']);
  });

  test('the retain warning keeps its marker; any other code gets its own directory', async () => {
    const disk = memoryStorageDriver();
    const storage = defineStorage({ disks: { assets: disk } });
    const prefix = retainedPrefix('app', 'staging');
    const store = retainedBuildOnce({ storage, prefix, buildId: 'b9' });
    const said: string[] = [];
    const ask = (code: string) => store({ code, role: 'web' }, () => void said.push(code));
    await ask('X_ASSET_RETAIN_UNDECLARED');
    await ask('X_ASSET_RETAIN_UNDECLARED');
    await ask('X_APP_OTHER');
    expect(said).toEqual(['X_ASSET_RETAIN_UNDECLARED', 'X_APP_OTHER']);
    expect([...disk.objects().keys()].sort()).toEqual(
      [`${warnedPrefix(prefix, 'web')}b9`, `${warnedPrefix(prefix, 'web~X_APP_OTHER')}b9`].sort(),
    );
  });
});
