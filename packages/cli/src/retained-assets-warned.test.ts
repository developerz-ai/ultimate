// A boot warning said once per build id per role across every process that shares the disk: the
// marker is the memory, a disk that refuses or stalls says the warning anyway (a duplicate line
// beats a lost one), and the markers are pruned to the newest few builds.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { StorageDriver } from '@ultimat3/storage';
import { defineStorage, memoryStorageDriver, resetStorage } from '@ultimat3/storage';
import { WARNED_BUILDS_KEPT, warnedPrefix, warnOncePerBuild } from './retained-assets-warned';

// `defineStorage` is process state: left defined, the next file on a shared worker reads this
// file's disks as its app's (`exercise-services.test.ts`: "an app that defined no storage").
afterAll(() => resetStorage());

const PREFIX = 'x-build-assets/app/production';

async function said(disk: StorageDriver, buildId: string, role = 'web', deadlineMs?: number) {
  let count = 0;
  await warnOncePerBuild({ disk: () => disk, prefix: PREFIX, role, buildId, deadlineMs }, () => {
    count += 1;
  });
  return count;
}

describe('warnOncePerBuild', () => {
  test('once per build id per role on one disk', async () => {
    const disk = memoryStorageDriver();
    expect(await said(disk, 'b1')).toBe(1);
    expect(await said(disk, 'b1')).toBe(0);
    expect(await said(disk, 'b1', 'worker')).toBe(1);
    expect(await said(disk, 'b2')).toBe(1);
  });

  test('a disk that refuses the check or the marker still says it, and never throws', async () => {
    const memory = memoryStorageDriver();
    const refusing: StorageDriver = {
      ...memory,
      exists: () => Promise.reject(new TypeError('bucket unreachable')),
    };
    expect(await said(refusing, 'b1')).toBe(1);
    expect(await said(refusing, 'b1')).toBe(1);
    const unwritable: StorageDriver = {
      ...memory,
      put: () => Promise.reject(new TypeError('read-only')),
    };
    expect(await said(unwritable, 'b1')).toBe(1);
    let count = 0;
    // A storage asked for a disk it never declared refuses with its own coded error.
    const storage = defineStorage({ disks: { uploads: memoryStorageDriver() } });
    const unnamed = () => storage.disk('assets');
    await warnOncePerBuild({ disk: unnamed, prefix: PREFIX, role: 'web', buildId: 'b1' }, () => {
      count += 1;
    });
    expect(count).toBe(1);
  });

  test('a disk that stalls past the deadline says it and lets the boot go on', async () => {
    const stalled: StorageDriver = {
      ...memoryStorageDriver(),
      exists: () => new Promise<boolean>(() => undefined),
    };
    expect(await said(stalled, 'b1', 'web', 10)).toBe(1);
  });

  test('a deadline that is not a positive finite count is refused, not fired at once', async () => {
    let caught: unknown;
    try {
      await said(memoryStorageDriver(), 'b1', 'web', Number.NaN);
    } catch (error) {
      caught = error;
    }
    expect(isUltimateError(caught) && caught.code).toBe('X_INVARIANT');
  });

  test('markers are pruned to the newest builds, so a deploy a day leaves no growing pile', async () => {
    // A clock a minute on per call: distinct modification times, so the newest are what survives.
    let minute = 0;
    const clock = {
      now: () => {
        minute += 1;
        return new Date(Date.UTC(2026, 10, 14, 0, minute));
      },
      monotonic: () => 0,
    };
    const disk = memoryStorageDriver({ clock });
    for (const build of ['b1', 'b2', 'b3', 'b4', 'b5']) expect(await said(disk, build)).toBe(1);
    const left = (await disk.list({ prefix: warnedPrefix(PREFIX, 'web') })).rows.map((r) => r.key);
    expect(left).toHaveLength(WARNED_BUILDS_KEPT);
    expect(left.some((key) => key.endsWith('/b5'))).toBe(true);
    expect(left.some((key) => key.endsWith('/b4'))).toBe(true);
    expect(left.some((key) => key.endsWith('/b1') || key.endsWith('/b2'))).toBe(false);
  });

  test('tied timestamps never prune the marker just written', async () => {
    const disk = memoryStorageDriver({ clock: { now: () => new Date(0), monotonic: () => 0 } });
    for (const build of ['b1', 'b2', 'b3', 'b4', 'b5']) expect(await said(disk, build)).toBe(1);
    expect(await said(disk, 'b5')).toBe(0);
  });
});
