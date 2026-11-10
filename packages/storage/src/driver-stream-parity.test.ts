// `streamRange` and `putStream` where a disk answers more than the port: the local disk's window
// read and staging directory, its etag rule, and the key-in-the-way refusal local and memory share.
// Every claim all three disks answer through the port is `storageDriverConformance`
// (`@ultimat3/testing`), run over memory, local and a real s3 server.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`.
import { tmpdir } from 'node:os';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { memoryStorageDriver } from './driver-memory';
import { bytesOf, catchError } from './driver-s3-fixture';
import { META_DIR } from './path';

const KEY = 'org/org-1/a.bin';
const clock = frozenClock('2026-07-26T12:00:00.000Z');
const anyCode = (caught: unknown): string =>
  isUltimateError(caught) ? caught.code : `not-a-coded-error: ${String(caught)}`;

let root = '';
let local: StorageDriver;

const streamOf = (...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const stagedFiles = async (): Promise<readonly string[]> =>
  readdir(`${root}/${META_DIR}/.tmp`).catch(() => []);

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-stream-parity-`);
  local = localDriver({ root, signingSecret: 'test-secret', clock, maxPutBytes: 8 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('streamRange on the local disk', () => {
  test('pulls only the window out of a large object', async () => {
    const huge = new Uint8Array(32 * 1024 * 1024);
    const big = localDriver({ root: `${root}/big`, signingSecret: 's', clock });
    await big.putStream(KEY, streamOf(huge), { maxBytes: huge.byteLength });
    let pulled = 0;
    for await (const chunk of await big.streamRange(KEY, [huge.byteLength - 10, huge.byteLength])) {
      pulled += chunk.byteLength;
    }
    expect(pulled).toBe(10);
  });
});

describe('putStream on the local disk', () => {
  test('the etag is the one put() would have recorded for those bytes', async () => {
    const roomy = localDriver({ root: `${root}/etag`, signingSecret: 's', clock });
    const put = await roomy.put('via-put', bytesOf('same bytes'));
    const streamed = await roomy.putStream('via-stream', streamOf(bytesOf('same bytes')), {
      maxBytes: 64,
    });
    expect(streamed.etag).toBe(put.etag);
    expect((await roomy.get('via-stream')).object.etag).toBe(put.etag);
  });

  test('a refused body strands no staged file: an overrun, a dying source, a bad option', async () => {
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(bytesOf('0123456789')),
    });
    expect(anyCode(await catchError(() => local.putStream(KEY, endless, { maxBytes: 16 })))).toBe(
      'X_STORAGE_TOO_LARGE',
    );
    let sent = false;
    const dying = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) controller.error(new TypeError('the client went away'));
        else controller.enqueue(bytesOf('partial'));
        sent = true;
      },
    });
    expect(anyCode(await catchError(() => local.putStream(KEY, dying, { maxBytes: 64 })))).toBe(
      'X_STORAGE_PUT_FAILED',
    );
    const unscreened = { maxBytes: Number.NaN };
    expect(anyCode(await catchError(() => local.putStream(KEY, streamOf(), unscreened)))).toBe(
      'X_INVARIANT',
    );
    expect(await stagedFiles()).toEqual([]);
  });

  test('a locked key and a key in the way refuse, and strand no temp file', async () => {
    const roomy = localDriver({ root, signingSecret: 's', clock });
    await roomy.put('held', bytesOf('x'), { legalHold: true });
    expect(
      anyCode(
        await catchError(() => roomy.putStream('held', streamOf(bytesOf('y')), { maxBytes: 8 })),
      ),
    ).toBe('X_STORAGE_OBJECT_LOCKED');
    await roomy.put('dir', bytesOf('x'));
    expect(
      anyCode(
        await catchError(() => roomy.putStream('dir/sub', streamOf(bytesOf('y')), { maxBytes: 8 })),
      ),
    ).toBe('X_STORAGE_KEY_CONFLICT');
    expect(await stagedFiles()).toEqual([]);
  });

  test('the memory disk refuses a key in the way as the local disk does', async () => {
    const memory = memoryStorageDriver();
    await memory.put('dir', bytesOf('x'));
    expect(
      anyCode(
        await catchError(() =>
          memory.putStream('dir/sub', streamOf(bytesOf('y')), { maxBytes: 8 }),
        ),
      ),
    ).toBe('X_STORAGE_KEY_CONFLICT');
    await memory.put('held', bytesOf('x'), { legalHold: true });
    expect(
      anyCode(
        await catchError(() => memory.putStream('held', streamOf(bytesOf('y')), { maxBytes: 8 })),
      ),
    ).toBe('X_STORAGE_OBJECT_LOCKED');
  });
});
