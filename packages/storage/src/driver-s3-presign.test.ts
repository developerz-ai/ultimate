// The two presigners of one s3 disk, held to one answer: the size-bound URL (core's `presignAwsUrl`)
// and Bun's own (no size). They must sign for the same region, take the same expiry and read the
// same options, or an app's grant works on one path and fails on the other.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { s3Driver } from './driver-s3';
import type { S3ClientLike } from './driver-s3-client';
import { catchError } from './driver-s3-fixture';
import { signingRegion } from './driver-s3-signed';

const KEY = 'org/org-1/a.png';
const KEYS = { S3_ACCESS_KEY_ID: 'key', S3_SECRET_ACCESS_KEY: 'secret' };
const clock = frozenClock('2026-07-26T12:00:00.000Z');
const anyCode = (caught: unknown): string =>
  isUltimateError(caught) ? caught.code : `not-a-coded-error: ${String(caught)}`;

const scopeOf = (url: string): string =>
  new URL(url).searchParams.get('X-Amz-Credential')?.split('/')[2] ?? 'no scope';

/** A disk whose Bun client is the real one, so its presign is Bun's own region rule. */
const diskAt = (endpoint: string | undefined) => {
  const client = new Bun.S3Client({
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    bucket: 'b',
    ...(endpoint === undefined ? {} : { endpoint }),
  });
  return s3Driver({
    bucket: 'b',
    client: client as unknown as S3ClientLike,
    env: KEYS,
    clock,
    ...(endpoint === undefined ? {} : { endpoint }),
  });
};

describe('the size-bound presign signs for the region Bun signs for', () => {
  // No S3_REGION: AWS refuses a URL signed for `auto`, so a grant minted that way failed every
  // browser upload while every server-side write on the same disk worked.
  for (const endpoint of [
    undefined,
    'https://s3.eu-west-1.amazonaws.com',
    'https://s3.amazonaws.com',
    'https://b.s3.eu-central-1.amazonaws.com',
    'https://s3.us-west-2.amazonaws.com/',
    'http://127.0.0.1:9000',
    'https://acc.r2.cloudflarestorage.com',
    'https://s3-eu-west-2.amazonaws.com',
  ]) {
    test(`endpoint ${String(endpoint)}`, async () => {
      const disk = diskAt(endpoint);
      const bun = await disk.signedUrl(KEY, { method: 'PUT' });
      const bound = await disk.signedUrl(KEY, { method: 'PUT', contentLength: 10 });
      expect(scopeOf(bound)).toBe(scopeOf(bun));
    });
  }

  test('an explicit region wins on both, as it does for Bun', async () => {
    expect(signingRegion({ bucket: 'b', region: 'ca-central-1', env: {} })).toBe('ca-central-1');
    expect(signingRegion({ bucket: 'b', env: { S3_REGION: 'ap-south-1' } })).toBe('ap-south-1');
  });

  // Where Bun's own reading is not a region at all, the one that is.
  test('a dual-stack AWS host signs for its region', () => {
    const env = { S3_ENDPOINT: 'https://s3.dualstack.ap-south-1.amazonaws.com' };
    expect(signingRegion({ bucket: 'b', env })).toBe('ap-south-1');
  });
});

describe('one expiry rule for both presigners', () => {
  test('past seven days is refused on the Bun path too, never minted', async () => {
    const disk = diskAt(undefined);
    for (const options of [{ method: 'PUT' }, { method: 'PUT', contentLength: 10 }] as const) {
      const refused = await catchError(() =>
        disk.signedUrl(KEY, { ...options, expiresInMs: 604_801_000 }),
      );
      expect(anyCode(refused)).toBe('X_INVARIANT');
    }
    expect(await disk.signedUrl(KEY, { method: 'PUT', expiresInMs: 604_800_000 })).toContain(
      'X-Amz-Expires=604800',
    );
  });
});

describe('maxBytes is a PUT ceiling', () => {
  test('a read ignores it, as the local disks do', async () => {
    const disk = diskAt(undefined);
    const url = await disk.signedUrl(KEY, { method: 'GET', maxBytes: 3 });
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(await disk.signedUrl(KEY, { maxBytes: 3 })).toContain('X-Amz-Signature=');
  });

  test('a PUT with no contentLength is still refused', async () => {
    const disk = diskAt(undefined);
    const refused = await catchError(() => disk.signedUrl(KEY, { method: 'PUT', maxBytes: 3 }));
    expect(anyCode(refused)).toBe('X_STORAGE_UPLOAD_SIZE_UNDECLARED');
  });
});
