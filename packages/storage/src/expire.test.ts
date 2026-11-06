// The app's window, on an injected clock: old goes, new stays, a locked object is reported and
// never forced, an undated one is spared — and abandoned sessions go with the objects.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { memoryStorageDriver } from './driver-memory';
import { bytesOf, catchError } from './driver-s3-fixture';
import { abortStaleUploads, expireObjects, objectPurgeTarget } from './expire';

const HOUR = 3_600_000;

const setup = async () => {
  const clock = frozenClock('2026-07-26T12:00:00.000Z');
  const disk = memoryStorageDriver({ signingSecret: 'test-secret', clock });
  await disk.put('exports/old.csv', bytesOf('a'));
  await disk.put('exports/locked.csv', bytesOf('b'), { legalHold: true });
  await disk.put('keep/old.csv', bytesOf('c'));
  clock.advance(25 * HOUR);
  await disk.put('exports/new.csv', bytesOf('d'));
  return { clock, disk };
};

describe('expireObjects', () => {
  test('old deleted, new kept, locked reported, outside the prefix untouched', async () => {
    const { clock, disk } = await setup();
    const result = await expireObjects({ disk, prefix: 'exports/', olderThanMs: 24 * HOUR, clock });
    expect(result.deleted).toEqual(['exports/old.csv']);
    expect(result.failed.map((failure) => failure.key)).toEqual(['exports/locked.csv']);
    expect(result.failed[0]?.reason).toContain('X_STORAGE_OBJECT_LOCKED');
    expect(result.spared).toEqual(['exports/new.csv']);
    expect(await disk.exists('exports/locked.csv')).toBe(true);
    expect(await disk.exists('keep/old.csv')).toBe(true);
  });

  test('an object whose age the disk did not report is spared', async () => {
    const { clock, disk } = await setup();
    const undated: StorageDriver = Object.assign(Object.create(disk), {
      list: async (options: Parameters<StorageDriver['list']>[0]) => {
        const page = await disk.list(options);
        return { ...page, rows: page.rows.map(({ lastModified: _, ...row }) => row) };
      },
    });
    const result = await expireObjects({
      disk: undated,
      prefix: 'exports/',
      olderThanMs: 0,
      clock,
    });
    expect(result.deleted).toEqual([]);
    expect(result.spared.length).toBe(3);
  });

  test('a window or a prefix that decides nothing is refused before a key is listed', async () => {
    const { clock, disk } = await setup();
    for (const olderThanMs of [Number.NaN, -1]) {
      await expect(
        expireObjects({ disk, prefix: 'exports/', olderThanMs, clock }),
      ).rejects.toBeUltimateError('X_INVARIANT');
    }
    const whole = await catchError(() =>
      expireObjects({ disk, prefix: '', olderThanMs: 0, clock }),
    );
    expect(whole).toBeUltimateError('X_INVARIANT');
    expect(await disk.exists('exports/old.csv')).toBe(true);
  });
});

describe('abortStaleUploads and objectPurgeTarget', () => {
  test('a session past the window is aborted, a fresh one spared', async () => {
    const { clock, disk } = await setup();
    const stale = await disk.multipart?.create('exports/big.bin', { contentType: 'text/csv' });
    if (stale === undefined) return expect.unreachable('the memory disk takes uploads in parts');
    clock.advance(2 * HOUR);
    await disk.multipart?.create('exports/fresh.bin', { contentType: 'text/csv' });
    const result = await abortStaleUploads({ disk, olderThanMs: HOUR, clock });
    expect(result.aborted.map((session) => session.uploadId)).toEqual([stale]);
    expect(result.spared.map((session) => session.key)).toEqual(['exports/fresh.bin']);
    expect((await disk.multipart?.listUploads())?.length).toBe(1);
  });

  test("the purge target sweeps on the JOB's clock and counts what went", async () => {
    const { disk } = await setup();
    await disk.multipart?.create('exports/big.bin', { contentType: 'text/csv' });
    const target = objectPurgeTarget({
      name: 'exports',
      disk,
      prefix: 'exports/',
      olderThanMs: 24 * HOUR,
    });
    expect(target.name).toBe('exports');
    // A job clock a week on: the old export, the new one and the session all fall out of the window.
    const weekOn = frozenClock('2026-08-03T12:00:00.000Z').now().getTime();
    expect(await target.purgeExpired(weekOn)).toBe(3);
    expect(await disk.exists('exports/locked.csv')).toBe(true);
    expect(await disk.multipart?.listUploads()).toEqual([]);
  });
});

// A per-tenant layout puts one kind of file under every org — `org/<id>/imports/…` beside
// `org/<id>/member/…/avatar` — and no single prefix names "every org's imports". `match` scopes the
// sweep to the keys it answers for, so the window that clears imports can never reach an avatar.
describe('objectPurgeTarget, scoped by `match`', () => {
  test('sweeps only the keys `match` answers for, objects and sessions alike', async () => {
    const clock = frozenClock('2026-07-26T12:00:00.000Z');
    const disk = memoryStorageDriver({ signingSecret: 'test-secret', clock });
    await disk.put('org/a/imports/posts/1/f.csv', bytesOf('a'));
    await disk.put('org/b/imports/posts/2/f.csv', bytesOf('b'));
    await disk.put('org/a/member/m/avatar/x.png', bytesOf('c'));
    await disk.multipart?.create('org/a/imports/posts/3/f.csv', { contentType: 'text/csv' });
    await disk.multipart?.create('org/a/media/big.mp4', { contentType: 'video/mp4' });
    const target = objectPurgeTarget({
      name: 'imports',
      disk,
      prefix: 'org/',
      match: (key) => /^org\/[^/]+\/imports\//.test(key),
      olderThanMs: HOUR,
    });
    const dayOn = frozenClock('2026-07-27T12:00:00.000Z').now().getTime();
    expect(await target.purgeExpired(dayOn)).toBe(3);
    expect(await disk.exists('org/a/member/m/avatar/x.png')).toBe(true);
    expect(await disk.exists('org/a/imports/posts/1/f.csv')).toBe(false);
    expect((await disk.multipart?.listUploads())?.map((session) => session.key)).toEqual([
      'org/a/media/big.mp4',
    ]);
  });
});
