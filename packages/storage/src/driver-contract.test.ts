// One claim, three disks. `driver-parity.test.ts` pins local against s3; these are the claims the
// memory disk has to hold too, because a test's disk that disagrees with production's is a suite
// that passes over a bug: keys that are prefixes of one another (refused by local and memory,
// held by s3), `stat()`, and the read ceiling.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove — `mkdtemp` and `rm` have no
// `Bun.*` equivalent, and the local disk needs a real directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask the platform where its
// temporary directory is.
import { tmpdir } from 'node:os';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { sweepOrphans } from './attachment';
import type { StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { memoryDriver } from './driver-memory';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, codeOf, FakeS3Client, textOf } from './driver-s3-fixture';

const clock = frozenClock('2026-07-26T12:00:00.000Z');
const anyCodeOf = (caught: unknown): string =>
  isUltimateError(caught) ? caught.code : `not-a-coded-error: ${String(caught)}`;

let root = '';
let fake: FakeS3Client;
let local: StorageDriver;
let memory: StorageDriver;
let s3: StorageDriver;
const disks = (): readonly StorageDriver[] => [local, memory, s3];

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-contract-`);
  fake = new FakeS3Client();
  local = localDriver({ root, signingSecret: 'test-secret', clock });
  memory = memoryDriver({ signingSecret: 'test-secret', clock });
  s3 = s3Driver({ bucket: 'b', client: fake });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a key that is a prefix of another key', () => {
  // The memory disk refuses with the local disk: it stands in for the dev disk, not for s3
  // (`driver-local-memory-parity.test.ts` holds the two to one answer).
  test('s3 holds both, in either order', async () => {
    for (const disk of [s3]) {
      await disk.put('a', bytesOf('file'));
      await disk.put('a/b', bytesOf('nested'));
      await disk.put('d/e', bytesOf('nested'));
      await disk.put('d', bytesOf('file'));
      expect(textOf((await disk.get('a')).bytes)).toBe('file');
      expect(textOf((await disk.get('a/b')).bytes)).toBe('nested');
      expect(textOf((await disk.get('d')).bytes)).toBe('file');
    }
  });

  // The pinned divergence: a POSIX path is a file or a directory, never both. It surfaced as a
  // bare `ENOTDIR` / `EISDIR` with no code and no fix; refused by name now, before a byte moves.
  test('the local disk refuses the second one by code, and the first is untouched', async () => {
    await local.put('a', bytesOf('file'), { contentType: 'text/plain' });
    expect(codeOf(await catchError(() => local.put('a/b', bytesOf('x'))))).toBe(
      'X_STORAGE_KEY_CONFLICT',
    );
    expect(codeOf(await catchError(() => local.put('a/b/c', bytesOf('x'))))).toBe(
      'X_STORAGE_KEY_CONFLICT',
    );
    const kept = await local.get('a');
    expect(textOf(kept.bytes)).toBe('file');
    expect(kept.object.contentType).toBe('text/plain');
    expect(await local.exists('a/b')).toBe(false);

    await local.put('d/e', bytesOf('nested'), { contentType: 'text/plain' });
    expect(codeOf(await catchError(() => local.put('d', bytesOf('x'))))).toBe(
      'X_STORAGE_KEY_CONFLICT',
    );
    expect(textOf((await local.get('d/e')).bytes)).toBe('nested');
    expect(await local.exists('d')).toBe(false);
    expect((await local.list()).objects.map((object) => object.key)).toEqual(['a', 'd/e']);
  });

  test('the refusal names the key in the way and a call that lists it', async () => {
    await local.put('a', bytesOf('file'));
    const refused = await catchError(() => local.put('a/b', bytesOf('x')));
    const rendered = isUltimateError(refused) ? `${refused.cause}\n${refused.fix}` : '';
    expect(rendered).toContain('"a/b"');
    expect(rendered).toContain('"a"');
    expect(rendered).toContain('.list({ prefix: ');
  });

  test('the fix names the disk as it was REGISTERED, not the driver kind', async () => {
    // `disk('local')` on a disk registered as `uploads` lists some other disk, or none at all.
    const uploads = localDriver({ root, signingSecret: 'test-secret', clock });
    uploads.registerAs?.('uploads');
    await uploads.put('a', bytesOf('file'));
    const refused = await catchError(() => uploads.put('a/b', bytesOf('x')));
    expect(isUltimateError(refused) ? refused.fix : '').toBe(
      'disk("uploads").list({ prefix: "a" })',
    );
    // Unregistered, the driver's own name is the only one there is.
    const bare = await catchError(() => local.put('a/b', bytesOf('x')));
    expect(isUltimateError(bare) ? bare.fix : '').toBe('disk("local").list({ prefix: "a" })');
  });

  test('a copy onto a colliding key is the same refusal, and the source survives', async () => {
    await local.put('a', bytesOf('file'));
    await local.put('src', bytesOf('copy-me'));
    expect(codeOf(await catchError(() => local.copy('src', 'a/b')))).toBe('X_STORAGE_KEY_CONFLICT');
    expect(textOf((await local.get('src')).bytes)).toBe('copy-me');
    expect(await local.exists('a/b')).toBe(false);
  });

  test('a collision in the SIDECAR tree is refused before the bytes land', async () => {
    // `a`'s sidecar is `.meta/a.json`, and `a.json/b`'s wants `.meta/a.json/` as a directory: the
    // object tree has no collision at all, so the bytes were written and only then did the sidecar
    // write throw — an object with no recorded type, left behind by a put() that "failed".
    await local.put('a', bytesOf('file'));
    expect(codeOf(await catchError(() => local.put('a.json/b', bytesOf('x'))))).toBe(
      'X_STORAGE_KEY_CONFLICT',
    );
    expect(await local.exists('a.json/b')).toBe(false);
    expect((await local.list()).objects.map((object) => object.key)).toEqual(['a']);
  });

  test('reading the half that is not there is "absent" on every disk', async () => {
    for (const disk of disks()) {
      await disk.put('p', bytesOf('file'));
      await disk.put('q/r', bytesOf('nested'));
      // `p/x` sits under a FILE on the local disk and `q` is a DIRECTORY there.
      for (const absent of ['p/x', 'q']) {
        expect(await disk.exists(absent)).toBe(false);
        expect(await disk.stat(absent)).toBeUndefined();
        expect(codeOf(await catchError(() => disk.get(absent)))).toBe('X_STORAGE_NOT_FOUND');
      }
      expect(textOf((await disk.get('p')).bytes)).toBe('file');
      expect(textOf((await disk.get('q/r')).bytes)).toBe('nested');
    }
  });
});

describe('stat answers what a read would, without the bytes', () => {
  test('every disk reports the size and type put() was told, and undefined for nothing', async () => {
    for (const disk of disks()) {
      await disk.put('org/o1/a.png', bytesOf('12345'), { contentType: 'image/png' });
      const stat = await disk.stat('org/o1/a.png');
      expect(stat?.key).toBe('org/o1/a.png');
      expect(stat?.size).toBe(5);
      expect(stat?.contentType).toBe('image/png');
      expect(await disk.stat('org/o1/missing.png')).toBeUndefined();
      expect(codeOf(await catchError(async () => disk.stat('../escape')))).toBe(
        'X_STORAGE_PATH_UNSAFE',
      );
    }
  });
});

describe('get() buffers, so it has a ceiling on every disk', () => {
  const build = (options: { maxGetBytes?: number; maxPutBytes?: number }): StorageDriver[] => [
    localDriver({ root, signingSecret: 'test-secret', clock, ...options }),
    memoryDriver({ signingSecret: 'test-secret', clock, ...options }),
    s3Driver({ bucket: 'b', client: fake, ...options }),
  ];

  test('an object over maxGetBytes is refused by code, and stream() still serves it', async () => {
    for (const disk of build({ maxGetBytes: 4 })) {
      await disk.put('big', bytesOf('12345'));
      await disk.put('fits', bytesOf('1234'));
      const refused = await catchError(() => disk.get('big'));
      expect(codeOf(refused)).toBe('X_STORAGE_TOO_LARGE');
      expect(isUltimateError(refused) ? refused.fix : '').toContain('maxGetBytes');
      expect(textOf((await disk.get('fits')).bytes)).toBe('1234');
      expect(await new Response(await disk.stream('big')).text()).toBe('12345');
    }
  });

  test('unset, the read ceiling is the write ceiling', async () => {
    // What a client PUT straight into the bucket is not bounded by `maxPutBytes`, so the object
    // arrives out of band here — exactly as an oversized presigned upload does.
    const [localDisk, , s3Disk] = build({ maxPutBytes: 4 });
    await Bun.write(`${root}/big`, '12345');
    fake.store.set('big', { bytes: bytesOf('12345') });
    for (const disk of [localDisk, s3Disk]) {
      if (disk === undefined) return expect.unreachable('three disks were built');
      expect(codeOf(await catchError(() => disk.get('big')))).toBe('X_STORAGE_TOO_LARGE');
    }
  });

  test.each([Number.NaN, 0, -1, 1.5])('maxGetBytes %p is refused where it is declared', (bad) => {
    for (const make of [
      () => localDriver({ root, signingSecret: 's', maxGetBytes: bad }),
      () => memoryDriver({ signingSecret: 's', maxGetBytes: bad }),
      () => s3Driver({ bucket: 'b', client: fake, maxGetBytes: bad }),
    ]) {
      let caught: unknown;
      try {
        make();
      } catch (error) {
        caught = error;
      }
      expect(anyCodeOf(caught)).toBe('X_INVARIANT');
    }
  });
});

describe('a provider that reports no lastModified is "unknown", never 1970', () => {
  test('the s3 listing and stat carry no lastModified at all', async () => {
    fake.listResult = { contents: [{ key: 'org/o1/pending/u.png', size: 1 }] };
    fake.store.set('org/o1/pending/u.png', { bytes: bytesOf('x') });
    const listed = (await s3.list({ prefix: 'org/o1/pending/' })).objects[0];
    expect(listed).toBeDefined();
    expect(listed && 'lastModified' in listed).toBe(false);
    const stat = await s3.stat('org/o1/pending/u.png');
    expect(stat && 'lastModified' in stat).toBe(false);
    expect((await s3.get('org/o1/pending/u.png')).object.lastModified).toBeUndefined();
  });

  test('sweepOrphans spares an object whose age nobody knows', async () => {
    // Epoch 0 is older than every window, so the sweep DELETED an upload on the strength of a
    // field the provider never sent.
    fake.listResult = {
      contents: [
        { key: 'org/o1/pending/unknown.png', size: 1 },
        { key: 'org/o1/pending/old.png', size: 1, lastModified: '2020-01-01T00:00:00.000Z' },
      ],
    };
    fake.store.set('org/o1/pending/unknown.png', { bytes: bytesOf('x') });
    fake.store.set('org/o1/pending/old.png', { bytes: bytesOf('x') });
    const swept = await sweepOrphans({ disk: s3, orgId: 'o1', olderThanMs: 60_000, clock });
    expect(swept.deleted).toEqual(['org/o1/pending/old.png']);
    expect(fake.store.has('org/o1/pending/unknown.png')).toBe(true);
  });
});

describe('a signed URL belongs to the disk that minted it', () => {
  // Two disks, ONE `STORAGE_SIGNING_SECRET` — the default for every local disk in a deployment.
  test('a URL from one registered disk does not verify on its sibling', async () => {
    for (const make of [
      () => localDriver({ root, signingSecret: 'shared-secret', clock }),
      () => memoryDriver({ signingSecret: 'shared-secret', clock }),
    ]) {
      const uploads = make();
      const vault = make();
      uploads.registerAs?.('uploads');
      vault.registerAs?.('vault');
      const url = await uploads.signedUrl('org/o1/a.png', { method: 'GET' });
      const moved = url.replace('/_storage/uploads/', '/_storage/vault/');
      expect(moved).not.toBe(url);

      expect((await uploads.verifySigned?.({ url }))?.ok).toBe(true);
      const crossed = await vault.verifySigned?.({ url: moved });
      expect(crossed?.ok === false ? crossed.reason : 'verified').toBe('signature-mismatch');
    }
  });
});
