// What a multipart grant's policy bounds, on every disk: no part is signed past what an object
// under the policy could hold, and no object is assembled past it. The server keeps no record of a
// grant, and the declared size is the client's own claim, so the policy is the bound that holds.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove — `mkdtemp` and `rm` have no
// `Bun.*` equivalent.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask the platform where its
// temporary directory is.
import { tmpdir } from 'node:os';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { acceptSignedPart } from './accept-part';
import type { StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { memoryStorageDriver } from './driver-memory';
import { s3Driver } from './driver-s3';
import { catchError, FAKE_ENV, FakeS3Client } from './driver-s3-fixture';
import {
  type CompleteUploadInput,
  completeUpload,
  grantMultipart,
  type SignPartInput,
  signPart,
} from './grant-multipart';
import { MIN_PART_BYTES } from './multipart';
import { uploadPolicy } from './upload';

const MiB = 1024 * 1024;
const clock = frozenClock('2026-07-26T12:00:00.000Z');
const policy = uploadPolicy({ maxBytes: 8 * MiB, allowedContentTypes: ['video/mp4'] });
const request = { filename: 'film.mp4', contentType: 'video/mp4', size: 6 * MiB };
const anyCodeOf = (caught: unknown): string =>
  isUltimateError(caught) ? caught.code : `not-a-coded-error: ${String(caught)}`;

let root = '';
let fake: FakeS3Client;
const disks = (): readonly (readonly [string, StorageDriver])[] => [
  ['memory', memoryStorageDriver({ signingSecret: 'test-secret', clock })],
  ['local', localDriver({ root, signingSecret: 'test-secret', clock })],
  ['s3', s3Driver({ bucket: 'b', client: fake, fetch: fake.fetch, env: FAKE_ENV, clock })],
];

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-grant-multipart-`);
  fake = new FakeS3Client();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const open = async (disk: StorageDriver) => {
  const grant = await grantMultipart({ disk, orgId: 'org-1', request, policy });
  return { disk, orgId: 'org-1', key: grant.key, uploadId: grant.uploadId };
};

/** One part's bytes onto the disk the way a browser's PUT would land them. */
const land = async (disk: StorageDriver, url: string, size: number): Promise<void> => {
  const bytes = new Uint8Array(size);
  if (disk.name === 's3') {
    expect((await fake.fetch(url, { method: 'PUT', headers: {}, body: bytes })).status).toBe(200);
    return;
  }
  await acceptSignedPart({ url, disk, orgId: 'org-1', bytes });
};

describe('signPart', () => {
  test('signs every part an upload under the policy can have', async () => {
    for (const [name, disk] of disks()) {
      const session = await open(disk);
      const first = await signPart({ ...session, policy, partNumber: 1, size: MIN_PART_BYTES });
      const tail = await signPart({ ...session, policy, partNumber: 2, size: MiB });
      expect([name, typeof first, typeof tail]).toEqual([name, 'string', 'string']);
    }
  });

  test('refuses a part no object under the policy holds', async () => {
    // The audit's repro: a 6 MiB grant under an 8 MiB policy, then four 6 MiB parts.
    const past: readonly (readonly [number, number])[] = [
      [2, 6 * MiB], // 2 × 6 MiB: every part but the last is as long as this one
      [2, 4 * MiB], // 5 MiB before it at the least, then 4 MiB
      [4, 1], // three 5 MiB parts before it
      [1, 8 * MiB + 1],
    ];
    for (const [name, disk] of disks()) {
      const session = await open(disk);
      for (const [partNumber, size] of past) {
        const refused = await catchError(() => signPart({ ...session, policy, partNumber, size }));
        expect([name, partNumber, size, anyCodeOf(refused)]).toEqual([
          name,
          partNumber,
          size,
          'X_STORAGE_TOO_LARGE',
        ]);
      }
      // Past S3's floor, the part's own length is the floor of each part before it: 12 MiB as
      // part 2 is 24 MiB at the least, even though 5 MiB + 12 MiB fits a 20 MiB policy.
      const wide = uploadPolicy({ maxBytes: 20 * MiB, allowedContentTypes: ['video/mp4'] });
      const second = { ...session, policy: wide, partNumber: 2 };
      expect([
        name,
        anyCodeOf(await catchError(() => signPart({ ...second, size: 12 * MiB }))),
      ]).toEqual([name, 'X_STORAGE_TOO_LARGE']);
      expect([name, typeof (await signPart({ ...second, size: 10 * MiB }))]).toEqual([
        name,
        'string',
      ]);
    }
  });

  test('refuses a call with no policy rather than signing an unbounded part', async () => {
    for (const [name, disk] of disks()) {
      const session = await open(disk);
      const untyped = { ...session, partNumber: 1, size: 1 } as unknown as SignPartInput;
      expect([name, anyCodeOf(await catchError(() => signPart(untyped)))]).toEqual([
        name,
        'X_INVARIANT',
      ]);
    }
  });
});

describe('completeUpload', () => {
  test('refuses a call with no policy before it assembles anything', async () => {
    for (const [name, disk] of disks()) {
      const session = await open(disk);
      await land(disk, await signPart({ ...session, policy, partNumber: 1, size: MiB }), MiB);
      const untyped = { ...session, parts: [{ partNumber: 1 }] } as unknown as CompleteUploadInput;
      expect([name, anyCodeOf(await catchError(() => completeUpload(untyped)))]).toEqual([
        name,
        'X_INVARIANT',
      ]);
      expect([name, await disk.stat(session.key)]).toEqual([name, undefined]);
    }
  });

  test('a total past the policy aborts the session and is too large', async () => {
    for (const [name, disk] of disks()) {
      const session = await open(disk);
      const sizes = [MIN_PART_BYTES, 3 * MiB];
      for (const [at, size] of sizes.entries()) {
        await land(disk, await signPart({ ...session, policy, partNumber: at + 1, size }), size);
      }
      const tighter = uploadPolicy({ maxBytes: 6 * MiB, allowedContentTypes: ['video/mp4'] });
      const parts = [{ partNumber: 1 }, { partNumber: 2 }];
      const refused = await catchError(() =>
        completeUpload({ ...session, parts, policy: tighter }),
      );
      expect([name, anyCodeOf(refused)]).toEqual([name, 'X_STORAGE_TOO_LARGE']);
      expect([name, await disk.multipart?.listUploads('org/org-1/')]).toEqual([name, []]);
      const object = await completeUpload({ ...session, parts, policy }).catch(anyCodeOf);
      expect([name, object]).toEqual([name, 'X_STORAGE_UPLOAD_UNKNOWN']);
    }
  });
});
