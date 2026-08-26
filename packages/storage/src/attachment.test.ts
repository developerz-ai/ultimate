import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove — `mkdtemp` and `rm` have no
// `Bun.*` equivalent, and this suite needs a real directory per run. Delete this import the day
// one lands.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask the platform where its
// temporary directory is.
import { tmpdir } from 'node:os';
import { frozenClock } from '@ultimat3/core';
import {
  attachmentKey,
  attachmentPrefix,
  isPendingKey,
  isQuarantinedKey,
  pendingKey,
  promoteAttachment,
  quarantineKey,
  releaseQuarantine,
  sweepOrphans,
  uploadExtension,
  uploadName,
} from './attachment';
import type { StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { deleteFailed, isStorageError } from './errors';

const ORG = 'org-1';
const TARGET = { entity: 'post', id: 'p-1', field: 'cover' } as const;
const START = '2026-07-26T12:00:00.000Z';

let root = '';
let disk: StorageDriver;
let clock: ReturnType<typeof frozenClock>;
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-storage-attach-`);
  clock = frozenClock(START);
  disk = localDriver({ root, signingSecret: 'test-secret', clock });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('uploadExtension', () => {
  // The filename is client-supplied; anything that is not a short alphanumeric suffix is DROPPED,
  // because sanitising is what turns a hostile name into one that merely looks safe.
  test('keeps a plain lowercase extension and drops everything else', () => {
    expect(uploadExtension('holiday.PNG')).toBe('.png');
    expect(uploadExtension('archive.tar.gz')).toBe('.gz');
    expect(uploadExtension('C:\\Users\\me\\report.pdf')).toBe('.pdf');
    expect(uploadExtension('noextension')).toBe('');
    expect(uploadExtension('.bashrc')).toBe('');
    expect(uploadExtension('evil.png/../../etc/passwd')).toBe('');
    expect(uploadExtension('a.p n g')).toBe('');
    expect(uploadExtension('a.verylongextension')).toBe('');
  });

  test('the id, never the filename, is what names the object', () => {
    expect(uploadName('u-1', '../../../etc/passwd.png')).toBe('u-1.png');
  });
});

describe('keys', () => {
  test('every key is org-scoped by construction', () => {
    expect(pendingKey(ORG, 'u-1.png')).toBe('org/org-1/pending/u-1.png');
    expect(attachmentKey(ORG, TARGET, 'u-1.png')).toBe('org/org-1/post/p-1/cover/u-1.png');
    expect(attachmentPrefix(ORG, TARGET)).toBe('org/org-1/post/p-1/cover/');
    expect(isPendingKey(pendingKey(ORG, 'u-1.png'), ORG)).toBe(true);
    expect(isPendingKey(pendingKey(ORG, 'u-1.png'), 'org-2')).toBe(false);
  });

  test('an org id with a separator cannot widen the namespace', () => {
    let caught: unknown;
    try {
      pendingKey('org-1/../org-2', 'u-1.png');
    } catch (error) {
      caught = error;
    }
    expect(isStorageError(caught) ? caught.code : '').toBe('X_STORAGE_PATH_UNSAFE');
  });
});

describe('promoteAttachment', () => {
  test('moves the bytes onto the row and leaves nothing pending', async () => {
    const key = pendingKey(ORG, 'u-1.png');
    await disk.put(key, bytesOf('cover-bytes'), { contentType: 'image/png' });

    const object = await promoteAttachment({ disk, key, orgId: ORG, target: TARGET });
    expect(object.key).toBe('org/org-1/post/p-1/cover/u-1.png');
    expect(object.contentType).toBe('image/png');
    expect(await disk.exists(key)).toBe(false);
    expect((await disk.get(object.key)).bytes.byteLength).toBe(11);
  });

  test('refuses to promote another org’s key', async () => {
    const key = pendingKey('org-2', 'u-1.png');
    await disk.put(key, bytesOf('x'), { contentType: 'image/png' });
    let caught: unknown;
    try {
      await promoteAttachment({ disk, key, orgId: ORG, target: TARGET });
    } catch (error) {
      caught = error;
    }
    expect(isStorageError(caught) ? caught.code : '').toBe('X_STORAGE_ORG_MISMATCH');
    // Nothing was copied INTO org-1 either — a failed promote must leave both orgs untouched.
    expect(await disk.exists('org/org-1/post/p-1/cover/u-1.png')).toBe(false);
  });
});

// A stub, not `localDriver`: a POSIX mtime comes from the real filesystem clock, so a sweep
// driven by an injected `Clock` cannot be tested against one without racing the wall clock.
// `driver-local.test.ts` already proves the disk half; this proves the age rule and the prefix.
function agedDisk(
  ages: Readonly<Record<string, string>>,
  refuse: ReadonlySet<string> = new Set(),
): {
  readonly driver: StorageDriver;
  readonly deleted: string[];
} {
  const deleted: string[] = [];
  const objects = Object.entries(ages).map(([key, when]) => ({
    key,
    size: 1,
    contentType: 'image/png',
    etag: 'e',
    lastModified: new Date(when),
  }));
  const driver = {
    name: 'aged',
    async list(options?: { readonly prefix?: string | undefined }) {
      const prefix = options?.prefix ?? '';
      return {
        objects: objects.filter(
          (object) => object.key.startsWith(prefix) && !deleted.includes(object.key),
        ),
        truncated: false,
      };
    },
    async delete(key: string) {
      // A refused delete is a THROW, exactly as the driver contract now says — the bucket
      // policy lost `s3:DeleteObject` and the object is still there.
      if (refuse.has(key)) {
        throw deleteFailed('aged', key, new Error('AccessDenied'), 'grant s3:DeleteObject');
      }
      deleted.push(key);
    },
  } as unknown as StorageDriver;
  return { driver, deleted };
}

describe('sweepOrphans', () => {
  test('collects stale pending uploads and reaches neither an attachment nor another org', async () => {
    const stale = pendingKey(ORG, 'stale.png');
    const { driver, deleted } = agedDisk({
      [stale]: '2026-07-26T10:00:00.000Z',
      [pendingKey(ORG, 'fresh.png')]: '2026-07-26T11:59:00.000Z',
      [attachmentKey(ORG, TARGET, 'kept.png')]: '2020-01-01T00:00:00.000Z',
      [pendingKey('org-2', 'theirs.png')]: '2020-01-01T00:00:00.000Z',
    });
    const swept = await sweepOrphans({
      disk: driver,
      orgId: ORG,
      olderThanMs: 1_800_000,
      clock,
    });
    expect(swept).toEqual({ deleted: [stale], failed: [] });
    expect(deleted).toEqual([stale]);
  });

  test('a REFUSED delete lands in `failed`, never in `deleted`', async () => {
    // The compliance case: a GDPR erasure sweep over a bucket whose policy lost
    // `s3:DeleteObject`. One array of "deleted" keys could not express this, so it reported
    // every refusal as a success and the report said the data was gone.
    const denied = pendingKey(ORG, 'denied.png');
    const gone = pendingKey(ORG, 'gone.png');
    const { driver, deleted } = agedDisk(
      {
        [denied]: '2020-01-01T00:00:00.000Z',
        [gone]: '2020-01-01T00:00:00.000Z',
      },
      new Set([denied]),
    );

    const swept = await sweepOrphans({
      disk: driver,
      orgId: ORG,
      olderThanMs: 1_800_000,
      clock,
    });
    expect(swept.deleted).toEqual([gone]);
    expect(swept.failed.map((failure) => failure.key)).toEqual([denied]);
    expect(swept.failed[0]?.reason).toContain('AccessDenied');
    // The sweep kept going past the refusal — a caller has to see all of them, not the first.
    expect(deleted).toEqual([gone]);
  });

  test('`keep` spares a key the app can still account for', async () => {
    const spared = pendingKey(ORG, 'spared.png');
    const dropped = pendingKey(ORG, 'dropped.png');
    const { driver, deleted } = agedDisk({
      [spared]: '2020-01-01T00:00:00.000Z',
      [dropped]: '2020-01-01T00:00:00.000Z',
    });
    const swept = await sweepOrphans({
      disk: driver,
      orgId: ORG,
      olderThanMs: 1_800_000,
      clock,
      keep: (object) => object.key === spared,
    });
    expect(swept).toEqual({ deleted: [dropped], failed: [] });
    expect(deleted).toEqual([dropped]);
  });

  test('reaches quarantined uploads too — they live inside the same pending prefix', async () => {
    const rotting = quarantineKey(ORG, 'never-scanned.png');
    const { driver, deleted } = agedDisk({ [rotting]: '2020-01-01T00:00:00.000Z' });
    const swept = await sweepOrphans({
      disk: driver,
      orgId: ORG,
      olderThanMs: 1_800_000,
      clock,
    });
    // An upload nobody ever scanned is still an orphan, and there is no second prefix to walk.
    expect(swept.deleted).toEqual([rotting]);
    expect(deleted).toEqual([rotting]);
  });
});

describe('quarantine', () => {
  test('promoteAttachment REFUSES a key nothing has cleared', async () => {
    const key = quarantineKey(ORG, 'u-1.png');
    await disk.put(key, bytesOf('maybe-ransomware'), { contentType: 'image/png' });

    let caught: unknown;
    try {
      await promoteAttachment({ disk, key, orgId: ORG, target: TARGET });
    } catch (error) {
      caught = error;
    }
    expect(isStorageError(caught) ? caught.code : '').toBe('X_STORAGE_QUARANTINED');
    // Nothing reached the row's prefix, and the bytes are still where the scan can find them.
    expect(await disk.exists(attachmentKey(ORG, TARGET, 'u-1.png'))).toBe(false);
    expect(await disk.exists(key)).toBe(true);
  });

  test('releaseQuarantine moves the object onto the pending key promotion accepts', async () => {
    const key = quarantineKey(ORG, 'u-1.png');
    await disk.put(key, bytesOf('clean-bytes'), { contentType: 'image/png' });
    expect(isQuarantinedKey(key, ORG)).toBe(true);
    expect(isPendingKey(key, ORG)).toBe(true);

    const released = await releaseQuarantine({ disk, key, orgId: ORG });
    expect(released).toBe(pendingKey(ORG, 'u-1.png'));
    expect(isQuarantinedKey(released, ORG)).toBe(false);
    expect(await disk.exists(key)).toBe(false);

    const object = await promoteAttachment({ disk, key: released, orgId: ORG, target: TARGET });
    expect(object.key).toBe(attachmentKey(ORG, TARGET, 'u-1.png'));
    expect(object.contentType).toBe('image/png');
  });

  test('releasing an already-released key is a no-op, not a second round trip', async () => {
    const key = pendingKey(ORG, 'u-1.png');
    await disk.put(key, bytesOf('x'), { contentType: 'image/png' });
    expect(await releaseQuarantine({ disk, key, orgId: ORG })).toBe(key);
    expect(await disk.exists(key)).toBe(true);
  });

  test('releaseQuarantine refuses another org’s key', async () => {
    const key = quarantineKey('org-2', 'u-1.png');
    await disk.put(key, bytesOf('x'), { contentType: 'image/png' });
    let caught: unknown;
    try {
      await releaseQuarantine({ disk, key, orgId: ORG });
    } catch (error) {
      caught = error;
    }
    expect(isStorageError(caught) ? caught.code : '').toBe('X_STORAGE_ORG_MISMATCH');
    expect(await disk.exists(key)).toBe(true);
  });
});
