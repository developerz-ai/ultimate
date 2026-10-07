// `promoteAttachment` is where a direct upload is first MEASURED on a bucket-backed disk: the s3
// presign carries no size, so the grant's `maxBytes` bound nothing until this call asked. Every
// claim runs on all three disks — a ceiling one of them skips is a ceiling production skips.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove — `mkdtemp` and `rm` have no
// `Bun.*` equivalent, and the local disk needs a real directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask the platform where its
// temporary directory is.
import { tmpdir } from 'node:os';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { attachmentKey, pendingKey, promoteAttachment, releaseQuarantine } from './attachment';
import type { StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { memoryStorageDriver } from './driver-memory';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, FakeS3Client, textOf } from './driver-s3-fixture';
import { uploadPolicy } from './upload';

const ORG = 'org-1';
const TARGET = { entity: 'post', id: 'p-1', field: 'cover' } as const;
const clock = frozenClock('2026-07-26T12:00:00.000Z');
const SMALL = uploadPolicy({ maxBytes: 10, allowedContentTypes: ['image/png'] });
const codeOf = (caught: unknown): string =>
  isUltimateError(caught) ? caught.code : `not-a-coded-error: ${String(caught)}`;

let root = '';
let disks: readonly StorageDriver[] = [];

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-promote-`);
  disks = [
    localDriver({ root, signingSecret: 'test-secret', clock }),
    memoryStorageDriver({ signingSecret: 'test-secret', clock }),
    s3Driver({ bucket: 'b', client: new FakeS3Client() }),
  ];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('promoteAttachment measures the upload against the policy', () => {
  test('an object over policy.maxBytes is refused on every disk, and nothing moves', async () => {
    for (const disk of disks) {
      const key = pendingKey(ORG, 'u-big.png');
      await disk.put(key, bytesOf('eleven-byte'), { contentType: 'image/png' });

      const refused = await catchError(() =>
        promoteAttachment({ disk, key, orgId: ORG, target: TARGET, policy: SMALL }),
      );
      expect(codeOf(refused)).toBe('X_STORAGE_TOO_LARGE');
      expect(isUltimateError(refused) ? refused.cause : '').toContain('11B');
      // Still pending, so `sweepOrphans` collects it; never at a key a row points to.
      expect(await disk.exists(key)).toBe(true);
      expect(await disk.exists(attachmentKey(ORG, TARGET, 'u-big.png'))).toBe(false);
    }
  });

  test('an object at the limit is promoted', async () => {
    for (const disk of disks) {
      const key = pendingKey(ORG, 'u-fits.png');
      await disk.put(key, bytesOf('ten-bytes!'), { contentType: 'image/png' });
      const object = await promoteAttachment({
        disk,
        key,
        orgId: ORG,
        target: TARGET,
        policy: SMALL,
      });
      expect(object.key).toBe(attachmentKey(ORG, TARGET, 'u-fits.png'));
      expect(object.size).toBe(10);
      expect(await disk.exists(key)).toBe(false);
    }
  });

  test('the policy is not optional — at compile time, and by code for a caller with no types', async () => {
    const [disk] = disks;
    if (disk === undefined) return expect.unreachable('three disks were built');
    const key = pendingKey(ORG, 'u.png');
    await disk.put(key, bytesOf('cover'), { contentType: 'image/png' });
    const input = { disk, key, orgId: ORG, target: TARGET };
    // @ts-expect-error — `policy` is required: a default ceiling silently replacing an app's own
    // is how a 50MB grant becomes a refused promotion in production and nowhere else.
    const refused = await catchError(() => promoteAttachment(input));
    expect(codeOf(refused)).toBe('X_INVARIANT');
    expect(isUltimateError(refused) ? refused.fix : '').toContain('policy: uploadPolicy(');
    expect(await disk.exists(key)).toBe(true);
  });
});

describe('a promotion that already happened answers the same object', () => {
  // Copy then delete, and then the caller's row write rolled back: the retry found no source and
  // raised X_STORAGE_NOT_FOUND for a file that was sitting, attached, exactly where it belonged.
  test('a gone source with a present destination returns the destination', async () => {
    for (const disk of disks) {
      const key = pendingKey(ORG, 'u-1.png');
      await disk.put(key, bytesOf('cover'), { contentType: 'image/png' });
      const input = { disk, key, orgId: ORG, target: TARGET, policy: SMALL };

      const first = await promoteAttachment(input);
      const again = await promoteAttachment(input);

      expect(again.key).toBe(first.key);
      expect(again.size).toBe(5);
      expect(again.contentType).toStartWith('image/png');
      expect(textOf((await disk.get(first.key)).bytes)).toBe('cover');
    }
  });

  test('a source that was never there is still X_STORAGE_NOT_FOUND', async () => {
    for (const disk of disks) {
      const refused = await catchError(() =>
        promoteAttachment({
          disk,
          key: pendingKey(ORG, 'never.png'),
          orgId: ORG,
          target: TARGET,
          policy: SMALL,
        }),
      );
      expect(codeOf(refused)).toBe('X_STORAGE_NOT_FOUND');
    }
  });
});

describe('an actor with no org is inside no org', () => {
  // `isWithinOrg(key, '')` THREW X_STORAGE_PATH_UNSAFE, so a missing org claim was reported as a
  // malformed key — a 400 blaming the upload, where the answer is the 404 every other tenant gets.
  test('promote and release both answer X_STORAGE_ORG_MISMATCH for an empty org', async () => {
    const [disk] = disks;
    if (disk === undefined) return expect.unreachable('three disks were built');
    const key = pendingKey(ORG, 'u-1.png');
    await disk.put(key, bytesOf('cover'), { contentType: 'image/png' });
    expect(
      codeOf(
        await catchError(() =>
          promoteAttachment({ disk, key, orgId: '', target: TARGET, policy: SMALL }),
        ),
      ),
    ).toBe('X_STORAGE_ORG_MISMATCH');
    expect(codeOf(await catchError(() => releaseQuarantine({ disk, key, orgId: '' })))).toBe(
      'X_STORAGE_ORG_MISMATCH',
    );
    expect(await disk.exists(key)).toBe(true);
  });
});
