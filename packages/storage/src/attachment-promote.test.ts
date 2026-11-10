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
import { attachmentKey, pendingKey, promoteAttachment } from './attachment';
import type { StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { memoryStorageDriver } from './driver-memory';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, FAKE_ENV, FakeS3Client, fakeEtagOf } from './driver-s3-fixture';
import { SNIFF_WINDOW_BYTES, uploadPolicy } from './upload';

const ORG = 'org-1';
const TARGET = { entity: 'post', id: 'p-1', field: 'cover' } as const;
const clock = frozenClock('2026-07-26T12:00:00.000Z');
const SMALL = uploadPolicy({ maxBytes: 10, allowedContentTypes: ['image/png'] });
/** Exactly at `SMALL`'s ceiling, and bytes the promotion's sniff agrees with. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const codeOf = (caught: unknown): string =>
  isUltimateError(caught) ? caught.code : `not-a-coded-error: ${String(caught)}`;

let root = '';
let disks: readonly StorageDriver[] = [];
let fake: FakeS3Client;

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-promote-`);
  fake = new FakeS3Client();
  disks = [
    localDriver({ root, signingSecret: 'test-secret', clock }),
    memoryStorageDriver({ signingSecret: 'test-secret', clock }),
    s3Driver({ bucket: 'b', client: fake, fetch: fake.fetch, env: FAKE_ENV }),
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
      await disk.put(key, PNG, { contentType: 'image/png' });
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

describe('a promotion that already happened is refused, and its bytes are never touched', () => {
  // 27.1.0 answered the second call with the attached object, indistinguishable from a move this
  // call made. An app's confirm then inserted a SECOND row for that key, the insert failed on its
  // unique key, and the cleanup every refused write runs deleted the object — the FIRST row's
  // bytes. Only the call that moved the bytes may answer them; a retry learns where they are.
  test('a gone source with a present destination is X_STORAGE_ALREADY_PROMOTED, naming it', async () => {
    for (const disk of disks) {
      const key = pendingKey(ORG, 'u-1.png');
      await disk.put(key, PNG, { contentType: 'image/png' });
      const input = { disk, key, orgId: ORG, target: TARGET, policy: SMALL };

      const first = await promoteAttachment(input);
      const again = await catchError(() => promoteAttachment(input));

      expect(codeOf(again)).toBe('X_STORAGE_ALREADY_PROMOTED');
      expect(isUltimateError(again) ? again.meta : undefined).toMatchObject({
        key,
        attachedKey: first.key,
      });
      expect(isUltimateError(again) ? again.fix : '').toContain(first.key);
      expect((await disk.get(first.key)).bytes).toEqual(PNG);
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
  test('promote answers X_STORAGE_ORG_MISMATCH for an empty org', async () => {
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
    expect(await disk.exists(key)).toBe(true);
  });
});

describe('promoteAttachment sniffs what is actually there', () => {
  const firstDisk = (): StorageDriver => disks[0] ?? expect.unreachable('three disks were built');
  const pngOf = (size: number): Uint8Array => {
    const bytes = new Uint8Array(size);
    bytes.set(PNG.subarray(0, 8));
    return bytes;
  };
  const verdictOf = async (promotion: Promise<unknown>): Promise<string> =>
    promotion.then(
      () => 'promoted',
      (error: unknown) => codeOf(error),
    );
  const IMAGES = uploadPolicy();
  const XML = uploadPolicy({
    maxBytes: 10 * SNIFF_WINDOW_BYTES,
    allowedContentTypes: ['application/xml'],
  });

  test('HTML under a pending key stating image/png is refused, and stays pending', async () => {
    for (const each of disks) {
      const key = pendingKey(ORG, 'u-html.png');
      await each.put(key, bytesOf('<!DOCTYPE html><script>1</script>'), {
        contentType: 'image/png',
      });
      const promotion = promoteAttachment({
        disk: each,
        key,
        orgId: ORG,
        target: TARGET,
        policy: IMAGES,
      });
      expect(await verdictOf(promotion)).toBe('X_STORAGE_TYPE_REJECTED');
      expect(await each.exists(key)).toBe(true);
      expect(await each.exists(attachmentKey(ORG, TARGET, 'u-html.png'))).toBe(false);
    }
  });

  test('a stored type the policy never allowed is refused, whatever the uploader sent', async () => {
    const disk = firstDisk();
    const key = pendingKey(ORG, 'u-typed.png');
    await disk.put(key, bytesOf('<!DOCTYPE html>'), { contentType: 'text/html' });
    const promotion = promoteAttachment({ disk, key, orgId: ORG, target: TARGET, policy: IMAGES });
    expect(await verdictOf(promotion)).toBe('X_STORAGE_TYPE_REJECTED');
    expect(await disk.exists(key)).toBe(true);
  });

  test('a PNG twice the disk’s maxGetBytes promotes, on one read of at most the window', async () => {
    const reads: (readonly [number, number] | undefined)[] = [];
    const memory = memoryStorageDriver({
      signingSecret: 'test-secret',
      maxPutBytes: 2 * SNIFF_WINDOW_BYTES,
      maxGetBytes: SNIFF_WINDOW_BYTES,
    });
    const counting: StorageDriver = Object.assign(Object.create(memory), {
      get: (key: string, options?: { readonly range?: readonly [number, number] }) => {
        reads.push(options?.range);
        return memory.get(key, options);
      },
    });
    const key = pendingKey(ORG, 'u-large.png');
    await memory.put(key, pngOf(2 * SNIFF_WINDOW_BYTES), { contentType: 'image/png' });

    const object = await promoteAttachment({
      disk: counting,
      key,
      orgId: ORG,
      target: TARGET,
      policy: uploadPolicy({ maxBytes: 2 * SNIFF_WINDOW_BYTES }),
    });
    expect(object.size).toBe(2 * SNIFF_WINDOW_BYTES);
    expect(reads).toEqual([[0, SNIFF_WINDOW_BYTES - 1]]);
  });

  test('a disk whose ceiling is under the window answers its own coded refusal', async () => {
    const small = memoryStorageDriver({ signingSecret: 'test-secret', maxGetBytes: 1024 });
    const key = pendingKey(ORG, 'u-small-ceiling.png');
    await small.put(key, pngOf(4096), { contentType: 'image/png' });
    const promotion = promoteAttachment({
      disk: small,
      key,
      orgId: ORG,
      target: TARGET,
      policy: IMAGES,
    });
    expect(await verdictOf(promotion)).toBe('X_STORAGE_TOO_LARGE');
    expect(await small.exists(key)).toBe(true);
  });

  test('XML over the window is refused; the same type within it is promoted', async () => {
    const disk = firstDisk();
    const over = pendingKey(ORG, 'u-over.xml');
    const within = pendingKey(ORG, 'u-within.xml');
    await disk.put(over, bytesOf(`<a>${'b'.repeat(SNIFF_WINDOW_BYTES)}</a>`), {
      contentType: 'application/xml',
    });
    await disk.put(within, bytesOf('<a>b</a>'), { contentType: 'application/xml' });
    const promote = (key: string) =>
      promoteAttachment({ disk, key, orgId: ORG, target: TARGET, policy: XML });
    expect(await verdictOf(promote(over))).toBe('X_STORAGE_TYPE_REJECTED');
    expect(await disk.exists(over)).toBe(true);
    expect((await promote(within)).contentType).toBe('application/xml');
  });

  test('an empty object reads nothing, and is judged as the empty body it is', async () => {
    const disk = firstDisk();
    const reads: unknown[] = [];
    const counting: StorageDriver = Object.assign(Object.create(disk), {
      get: (...args: unknown[]) => {
        reads.push(args);
        return expect.unreachable('a 0-byte object has no range to read');
      },
    });
    const key = pendingKey(ORG, 'u-empty.png');
    await disk.put(key, new Uint8Array(), { contentType: 'image/png' });
    const promotion = promoteAttachment({
      disk: counting,
      key,
      orgId: ORG,
      target: TARGET,
      policy: IMAGES,
    });
    expect(await verdictOf(promotion)).toBe('X_STORAGE_TYPE_REJECTED');
    expect(reads).toEqual([]);
  });

  // The presigned PUT stays valid until it expires, so the uploader can overwrite after the sniff.
  describe('the bytes that move are the bytes that were judged', () => {
    /** Exactly `PNG`'s length, so neither the size nor the ceiling tells them apart. */
    const HTML = bytesOf('<html></x>');
    const withNoEtag = async (disk: StorageDriver, key: string) => {
      const object = await disk.stat(key);
      return object === undefined ? undefined : { ...object, etag: '' };
    };
    /**
     * The uploader's second PUT lands in the gap between the sniff and the copy. `honours` is a disk
     * whose `copy` applies the condition; without it, one that takes no condition at all.
     */
    const racing = (
      disk: StorageDriver,
      bytes: Uint8Array,
      options: { readonly honours?: boolean; readonly reported?: string } = {},
    ): StorageDriver =>
      Object.assign(Object.create(disk), {
        copy: async (from: string, to: string, condition?: { readonly ifMatch?: string }) => {
          await disk.put(from, bytes, { contentType: 'image/png' });
          const object = await disk.copy(from, to, options.honours ? condition : undefined);
          return options.reported === undefined ? object : { ...object, etag: options.reported };
        },
        ...(options.reported === '' ? { stat: async (key: string) => withNoEtag(disk, key) } : {}),
      });
    const promoting = (disk: StorageDriver, key: string, policy = uploadPolicy()) =>
      catchError(() => promoteAttachment({ disk, key, orgId: ORG, target: TARGET, policy }));

    test('a disk that honours ifMatch refuses the copy, and writes nothing', async () => {
      for (const each of disks) {
        const key = pendingKey(ORG, 'u-cond.png');
        await each.put(key, PNG, { contentType: 'image/png' });
        // The fake's `stat` reports what a provider assigned, and it has assigned nothing yet.
        const entry = fake.store.get(key);
        if (entry !== undefined) entry.etag = fakeEtagOf(entry);
        const refused = await promoting(racing(each, HTML, { honours: true }), key);
        expect(codeOf(refused)).toBe('X_STORAGE_OBJECT_CHANGED');
        expect(await each.exists(attachmentKey(ORG, TARGET, 'u-cond.png'))).toBe(false);
        expect(await each.exists(key)).toBe(true);
      }
    });

    test('a disk that takes no condition: same size, another etag, so the copy is judged', async () => {
      for (const each of disks) {
        const key = pendingKey(ORG, 'u-race.png');
        await each.put(key, PNG, { contentType: 'image/png' });
        expect(codeOf(await promoting(racing(each, HTML), key))).toBe('X_STORAGE_TYPE_REJECTED');
        expect(await each.exists(attachmentKey(ORG, TARGET, 'u-race.png'))).toBe(false);
        expect(await each.exists(key)).toBe(true);
      }
    });

    test('a disk that reports no etag cannot compare, so the copy is judged too', async () => {
      for (const each of disks) {
        const key = pendingKey(ORG, 'u-no-etag.png');
        await each.put(key, PNG, { contentType: 'image/png' });
        const refused = await promoting(racing(each, HTML, { reported: '' }), key);
        expect(codeOf(refused)).toBe('X_STORAGE_TYPE_REJECTED');
        expect(await each.exists(attachmentKey(ORG, TARGET, 'u-no-etag.png'))).toBe(false);
      }
    });

    test('an etag the copy changes on its own (SSE-KMS) is no refusal when the bytes agree', async () => {
      for (const each of disks) {
        const key = pendingKey(ORG, 'u-kms.png');
        await each.put(key, PNG, { contentType: 'image/png' });
        const object = await promoteAttachment({
          disk: racing(each, PNG, { reported: 'kms-opaque-etag' }),
          key,
          orgId: ORG,
          target: TARGET,
          policy: uploadPolicy(),
        });
        expect(object.key).toBe(attachmentKey(ORG, TARGET, 'u-kms.png'));
        expect(await each.exists(key)).toBe(false);
      }
    });

    test('a copy of another size is refused whatever else agrees: 100,000 B under a 1,000 B policy', async () => {
      for (const each of disks) {
        const key = pendingKey(ORG, 'u-grown.png');
        await each.put(key, PNG, { contentType: 'image/png' });
        const grown = new Uint8Array(100_000);
        grown.set(PNG.subarray(0, 8));
        const small = uploadPolicy({ maxBytes: 1_000 });
        const refused = await promoting(racing(each, grown), key, small);
        expect(codeOf(refused)).toBe('X_STORAGE_OBJECT_CHANGED');
        expect(await each.exists(attachmentKey(ORG, TARGET, 'u-grown.png'))).toBe(false);
      }
    });

    test('a stored type changed under the same bytes is the copy judged, and refused', async () => {
      for (const each of disks) {
        const key = pendingKey(ORG, 'u-type.png');
        await each.put(key, PNG, { contentType: 'image/png' });
        const retyped: StorageDriver = Object.assign(Object.create(each), {
          copy: async (from: string, to: string) => ({
            ...(await each.copy(from, to)),
            contentType: 'text/html',
          }),
        });
        expect(codeOf(await promoting(retyped, key))).toBe('X_STORAGE_TYPE_REJECTED');
        expect(await each.exists(attachmentKey(ORG, TARGET, 'u-type.png'))).toBe(false);
      }
    });
  });
});
