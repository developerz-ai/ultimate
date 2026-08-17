// One question, one answer, whichever DISK is asked. `localDriver` is what `x dev`, every test in
// this repo and every test in an app runs against; `s3Driver` is what production runs against — so
// a semantic only one of them holds is a guarantee that passes CI and fails on deploy. Both are
// real objects here (the s3 one over `FakeS3Client`, no socket), so each case asserts BOTH drivers'
// behaviour in ONE test and neither can move alone.
//
// Where the two genuinely CANNOT agree — a POSIX file has no user metadata header, a provider
// presign has no size field — the test pins the divergence itself, in one place, with the reason.
// That is the honest form of parity: the pair still moves together the day either half changes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { frozenClock } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, codeOf, FakeS3Client, s3Error } from './driver-s3-fixture';
import { SIGNED_URL_PARAMS } from './signed-url';

const KEY = 'org/org-1/a.txt';
const clock = frozenClock('2026-07-26T12:00:00.000Z');

let root = '';
let local: StorageDriver;
let fake: FakeS3Client;
let s3: StorageDriver;

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-parity-`);
  local = localDriver({ root, signingSecret: 'test-secret', clock });
  fake = new FakeS3Client();
  s3 = s3Driver({ bucket: 'b', client: fake });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a REFUSED listing is a refusal on both disks, never an empty page', () => {
  test('local and s3 both answer X_STORAGE_LIST_FAILED', async () => {
    // `sweepOrphans` walks `list()`, so a swallowed refusal is a GDPR erasure report certifying a
    // prefix nothing could read as having no orphans — the exact false report `delete()`'s
    // `.catch(() => undefined)` used to make, one call to the left. The local driver caught every
    // error and answered `{ objects: [], truncated: false }`; the s3 driver let a bare `S3Error`
    // escape with no code, no fix and nothing for the http error map to render but a 500.
    const file = `${root}/not-a-directory`;
    await writeFile(file, 'x');
    const onAFile = localDriver({ root: file, signingSecret: 'test-secret', clock });
    expect(codeOf(await catchError(() => onAFile.list()))).toBe('X_STORAGE_LIST_FAILED');

    fake.failListWith = s3Error('AccessDenied', 403, 'org/org-1/');
    expect(codeOf(await catchError(() => s3.list({ prefix: 'org/org-1/' })))).toBe(
      'X_STORAGE_LIST_FAILED',
    );
  });

  test('and a disk with nothing in it is an empty page on both, not a refusal', async () => {
    // The other half, and the one the local driver's bare `catch` was there for: a root nobody has
    // written to has no directory yet. Losing this is a boot that fails on an empty disk.
    const unwritten = localDriver({ root: `${root}/never-created`, signingSecret: 's', clock });
    expect(await unwritten.list()).toEqual({ objects: [], truncated: false });
    expect(await s3.list()).toEqual({ objects: [], truncated: false });
  });
});

describe('a listing reports only what a listing can know', () => {
  test('neither disk invents a contentType, and neither reads an object to answer', async () => {
    // s3's `ListObjectsV2` carries no Content-Type and the driver used to fill in
    // `application/octet-stream`, so a caller filtering a listing by type got every object on
    // `local` and none on `s3`. The local half is a key with no sidecar — the state a `put()` that
    // died between its two writes leaves — where this driver equally cannot know.
    //
    // `etag: ''` is the same rule applied to the etag, and it is what stops `list()` reading every
    // file it lists: hashing a sidecar-less object meant one full buffered read per listed row,
    // sequentially, under a comment promising the opposite.
    await writeFile(`${root}/loose.txt`, 'sidecar-less');
    const listedLocal = (await local.list()).objects[0];
    expect(listedLocal?.contentType).toBeUndefined();
    expect(listedLocal?.etag).toBe('');

    fake.listResult = { contents: [{ key: KEY, size: 5, eTag: 'provider-etag' }] };
    const listedS3 = (await s3.list()).objects[0];
    expect(listedS3?.contentType).toBeUndefined();

    // A `get()` promises a type and an etag, because it has actually looked at the object — so the
    // local driver hashes THERE, out of bytes it already holds, rather than in the listing.
    const read = await local.get('loose.txt');
    expect(read.object.contentType).toBe('application/octet-stream');
    expect(read.object.etag).not.toBe('');
  });
});

describe('delete is idempotent for an ABSENT key and for nothing else', () => {
  test('both disks swallow "not there" and both surface a refusal', async () => {
    // Both drivers used to end in `.catch(() => undefined)`. Pinned together because the classifier
    // is per-driver — `ENOENT` on a POSIX unlink, a provider `code`/404 on S3 — and a fix to one
    // side alone is how they came to disagree in the first place.
    await expect(local.delete('org/org-1/never-written.txt')).resolves.toBeUndefined();
    fake.absentDeleteFor = KEY;
    await expect(s3.delete(KEY)).resolves.toBeUndefined();

    // A directory in the object's place is the cheapest unlink the OS refuses with something
    // other than ENOENT, and it needs no root and no chmod.
    await writeFile(`${root}/blocked/child.txt`, 'x', { flag: 'w' }).catch(async () => {
      await Bun.write(`${root}/blocked/child.txt`, 'x');
    });
    expect(codeOf(await catchError(() => local.delete('blocked')))).toBe('X_STORAGE_DELETE_FAILED');
    fake.absentDeleteFor = undefined;
    fake.failDeleteFor = KEY;
    await s3.put(KEY, bytesOf('x'));
    expect(codeOf(await catchError(() => s3.delete(KEY)))).toBe('X_STORAGE_DELETE_FAILED');
  });
});

describe('put refuses what its disk cannot honour', () => {
  test('server-side encryption is refused by BOTH, so it is one rule and not two', async () => {
    const sse = { serverSideEncryption: { algorithm: 'AES256' } } as const;
    expect(codeOf(await catchError(() => local.put(KEY, bytesOf('x'), sse)))).toBe(
      'X_NOT_IMPLEMENTED',
    );
    expect(codeOf(await catchError(() => s3.put(KEY, bytesOf('x'), sse)))).toBe(
      'X_NOT_IMPLEMENTED',
    );
  });

  test('metadata and cacheControl are the one PutOptions pair the disks disagree about', async () => {
    // KNOWN DIVERGENCE, pinned rather than resolved. `Bun.S3Client.write` exposes `type`, `acl`
    // and `storageClass` and no header hook for `x-amz-meta-*` or `Cache-Control`, so the s3
    // driver refuses with an out-of-band command; the local driver stores both in its sidecar and
    // reads them back. An app that develops on `local` and ships on `s3` meets this at its first
    // production `put()`.
    //
    // Both halves are here so neither moves alone: the day Bun grows the hook, the s3 line fails
    // and the resolution is to make it store them — never to make the local disk forget how.
    const object = await local.put(KEY, bytesOf('x'), {
      cacheControl: 'public, max-age=60',
      metadata: { uploadedBy: 'user-1' },
    });
    expect(object.cacheControl).toBe('public, max-age=60');
    expect(object.metadata).toEqual({ uploadedBy: 'user-1' });

    expect(
      codeOf(await catchError(() => s3.put(KEY, bytesOf('x'), { metadata: { a: 'b' } }))),
    ).toBe('X_NOT_IMPLEMENTED');
    expect(
      codeOf(await catchError(() => s3.put(KEY, bytesOf('x'), { cacheControl: 'no-cache' }))),
    ).toBe('X_NOT_IMPLEMENTED');
  });

  test('the server-side byte ceiling is enforced by both, with the same code', async () => {
    const tooBig = bytesOf('x'.repeat(64));
    const tinyLocal = localDriver({ root, signingSecret: 's', clock, maxPutBytes: 8 });
    const tinyS3 = s3Driver({ bucket: 'b', client: fake, maxPutBytes: 8 });
    expect(codeOf(await catchError(() => tinyLocal.put(KEY, tooBig)))).toBe('X_STORAGE_TOO_LARGE');
    expect(codeOf(await catchError(() => tinyS3.put(KEY, tooBig)))).toBe('X_STORAGE_TOO_LARGE');
  });
});

describe('a signed PUT carries maxBytes on one disk and cannot on the other', () => {
  test('local signs the ceiling into the URL; the s3 presign is handed no size at all', async () => {
    // KNOWN DIVERGENCE, and the one with teeth. `grantUpload` passes `maxBytes: policy.maxBytes`
    // to every driver (`grant.ts`), and the local disk puts it inside the signature so
    // `acceptSignedUpload` can refuse a widened one. S3 has no header for a size and Bun's
    // `presign` takes method, expiry and type — so on the production disk the client PUTs straight
    // into the bucket and NOTHING between the grant and the object enforces the ceiling.
    //
    // Refusing `maxBytes` in the s3 driver is not the fix and this test is where that is recorded:
    // `grantUpload` always supplies it, so a refusal would break every s3 upload grant in every
    // app. What the ceiling needs is an accept path or a bucket rule, neither of which is a driver.
    const url = await local.signedUrl(KEY, { method: 'PUT', maxBytes: 1024 });
    expect(new URL(url, 'https://x.test').searchParams.get(SIGNED_URL_PARAMS.maxBytes)).toBe(
      '1024',
    );

    const presigned = await s3.signedUrl(KEY, { method: 'PUT', maxBytes: 1024 });
    expect(presigned).not.toContain('1024');
    expect(fake.presignCalls.at(-1)?.options).toEqual({ method: 'PUT', expiresIn: 900 });
  });
});
