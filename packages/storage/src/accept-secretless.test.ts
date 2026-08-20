// The mount blocker, as a test. `acceptSignedUpload` required a `secret:` and `localDriver` closes
// over the one it mints with, so a route holding a `Storage` registry had no way to reach it — the
// upload half shipped, tested, and reachable from nothing. These are the cases a route needs:
// verify through the disk that signed, and refuse clearly when the disk cannot.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { frozenClock } from '@ultimat3/core';
import { acceptSignedUpload, readSignedObject } from './accept';
import type { StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { isStorageError } from './errors';
import { grantUpload } from './grant';
import { defineStorage, resetStorage } from './storage';
import { uploadPolicy } from './upload';

const SECRET = 'test-signing-secret';
const START = '2026-07-26T12:00:00.000Z';
const ORG = 'org-1';
const IMAGES = uploadPolicy({ maxBytes: 1024, allowedContentTypes: ['image/png'] });

let root = '';
let disk: StorageDriver;
let clock: ReturnType<typeof frozenClock>;

function genuinePng(padding = 32): Uint8Array {
  const header = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ];
  return new Uint8Array([...header, ...new Array<number>(padding).fill(0x01)]);
}

async function outcomeOf(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await fn();
  } catch (error) {
    if (!isStorageError(error)) return { code: `not-a-storage-error: ${String(error)}` };
    return { code: error.code, reason: error.meta?.['reason'] };
  }
  return { code: 'no-error-thrown' };
}

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-storage-secretless-`);
  clock = frozenClock(START);
  disk = localDriver({ root, signingSecret: SECRET, clock });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const grant = (): ReturnType<typeof grantUpload> =>
  grantUpload({
    disk,
    orgId: ORG,
    policy: IMAGES,
    clock,
    uploadId: () => 'upload-1',
    request: { filename: 'holiday.png', contentType: 'image/png' },
  });

describe('a disk verifies what it signed, without surrendering the secret', () => {
  test('the driver exposes verification and NOT the secret it verifies with', () => {
    expect(typeof disk.verifySigned).toBe('function');
    // The whole point. A route holds the driver; a route must not be able to mint with it.
    expect(Object.values(disk)).not.toContain(SECRET);
    expect(JSON.stringify(disk)).not.toContain(SECRET);
  });

  test('an upload is accepted with no secret in the call at all', async () => {
    const minted = await grant();
    const stored = await acceptSignedUpload({
      url: minted.url,
      disk,
      orgId: ORG,
      bytes: genuinePng(),
      declaredContentType: 'image/png',
      policy: IMAGES,
      clock,
    });
    expect(stored.key).toBe(minted.key);
    expect(await disk.exists(minted.key)).toBe(true);
  });

  test('a read is served with no secret either — both halves of the route, one seam', async () => {
    const minted = await grant();
    await acceptSignedUpload({
      url: minted.url,
      disk,
      orgId: ORG,
      bytes: genuinePng(),
      declaredContentType: 'image/png',
      policy: IMAGES,
      clock,
    });
    const url = await disk.signedUrl(minted.key);
    const read = await readSignedObject({ url, disk, orgId: ORG, clock });
    expect(read.object.key).toBe(minted.key);
  });

  test('every refusal still refuses — the seam moves who holds the secret, not what is checked', async () => {
    const minted = await grant();
    const forged = minted.url.replace(/x-sig=[^&]*/, 'x-sig=deadbeef');
    const accept =
      (url: string, orgId = ORG): (() => Promise<unknown>) =>
      (): Promise<unknown> =>
        acceptSignedUpload({
          url,
          disk,
          orgId,
          bytes: genuinePng(),
          declaredContentType: 'image/png',
          policy: IMAGES,
          clock,
        });

    expect(await outcomeOf(accept(forged))).toEqual({
      code: 'X_STORAGE_URL_INVALID',
      reason: 'signature-mismatch',
    });
    expect((await outcomeOf(accept(minted.url, 'org-2')))['code']).toBe('X_STORAGE_ORG_MISMATCH');
    clock.advance(60 * 60 * 1000);
    expect((await outcomeOf(accept(minted.url)))['code']).toBe('X_STORAGE_URL_EXPIRED');
  });

  test('the CALL’s clock governs expiry, not the one the disk was built with', async () => {
    // A route's disk is built at boot with the system clock; the caller's clock is the one that
    // knows what "now" means for this request. Without the override a frozen-clock caller would be
    // judged against wall time, and every expiry assertion in a suite would pass for that reason.
    const bootClock = frozenClock(START);
    const bootDisk = localDriver({ root, signingSecret: SECRET, clock: bootClock });
    const minted = await grantUpload({
      disk: bootDisk,
      orgId: ORG,
      policy: IMAGES,
      clock: bootClock,
      uploadId: () => 'upload-3',
      request: { filename: 'holiday.png', contentType: 'image/png' },
    });

    const late = frozenClock(START);
    late.advance(60 * 60 * 1000);
    const outcome = await outcomeOf(() =>
      acceptSignedUpload({
        url: minted.url,
        disk: bootDisk,
        orgId: ORG,
        bytes: genuinePng(),
        declaredContentType: 'image/png',
        policy: IMAGES,
        clock: late,
      }),
    );
    expect(outcome['code']).toBe('X_STORAGE_URL_EXPIRED');
    // …and the disk's own clock still answers when the call names none.
    expect(await disk.verifySigned?.({ url: minted.url })).toBeDefined();
  });

  test('an explicit secret still wins, so every call that shipped keeps working', async () => {
    const minted = await grant();
    const stored = await acceptSignedUpload({
      url: minted.url,
      secret: SECRET,
      disk,
      orgId: ORG,
      bytes: genuinePng(),
      declaredContentType: 'image/png',
      policy: IMAGES,
      clock,
    });
    expect(stored.key).toBe(minted.key);
  });
});

describe('a disk that can neither be given a secret nor verify one', () => {
  test('refuses by name, and names both ways out', async () => {
    // An s3-shaped driver: the URLs are the provider's, so this package never verifies them. The
    // key is OMITTED rather than set to `undefined` — `verifySigned?` is an optional member under
    // `exactOptionalPropertyTypes`, and a driver that declares it as absent is the real shape.
    const { verifySigned: _unused, ...rest } = disk;
    const provider: StorageDriver = { ...rest, name: 's3' };
    const outcome = await outcomeOf(() =>
      readSignedObject({ url: '/_storage/s3/a.png?x-sig=x', disk: provider, orgId: ORG, clock }),
    );
    expect(outcome['code']).toBe('X_STORAGE_URL_UNVERIFIABLE');
  });
});

describe('what a mounted route actually holds', () => {
  // The blocker, stated as the route's own view: `storageRoutes({ storage })` is handed a REGISTRY
  // and nothing else — no secret, no config — which is why the shipped `PUT` half of
  // `/_storage/:disk/*key` has never been mounted. This is that handler, minus the Request.
  test('a disk resolved from the registry accepts an upload with nothing but the registry', async () => {
    const registry = defineStorage({ disks: { uploads: disk }, default: 'uploads' });
    try {
      const minted = await grantUpload({
        disk: registry.disk('uploads'),
        orgId: ORG,
        policy: IMAGES,
        clock,
        uploadId: () => 'upload-2',
        request: { filename: 'holiday.png', contentType: 'image/png' },
      });

      // Everything below is reachable from `{ params, headers, body }` and the registry.
      const resolved = registry.disk('uploads');
      const stored = await acceptSignedUpload({
        url: minted.url,
        disk: resolved,
        orgId: ORG,
        bytes: genuinePng(),
        declaredContentType: 'image/png',
        clock,
      });

      expect(stored.key).toBe(minted.key);
      expect(await resolved.exists(stored.key)).toBe(true);
    } finally {
      resetStorage();
    }
  });
});
