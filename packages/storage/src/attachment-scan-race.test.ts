// `promoteAttachment`'s scan step under concurrency: a doubled confirm whose first scan fails after
// the second has attached must not delete the second's committed file, and a scanner that returns
// before reading the whole body must not leave the disk's stream (an S3 connection) open.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { attachmentKey, pendingKey, pendingPrefix, promoteAttachment } from './attachment';
import type { StorageDriver } from './driver';
import { memoryStorageDriver } from './driver-memory';
import { uploadPolicy } from './upload';
import { installUploadScanner, resetUploadScanner, type ScanVerdict } from './upload-scanner';

const ORG = 'org-1';
const TARGET = { entity: 'post', id: 'p-1', field: 'file' } as const;
const TEXT = uploadPolicy({ allowedContentTypes: ['text/plain'] });
const disk = () =>
  memoryStorageDriver({ signingSecret: 's', clock: frozenClock('2026-11-09T00:00:00Z') });
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

afterEach(() => resetUploadScanner());

describe('promoteAttachment scanning under concurrency', () => {
  test("a doubled confirm whose scanner fails late never deletes the sibling's attached file", async () => {
    const store = disk();
    const key = pendingKey(ORG, 'u-1.txt');
    await store.put(key, encode('a plain note'), { contentType: 'text/plain' });
    let failFirst: (reason: unknown) => void = () => undefined;
    let calls = 0;
    installUploadScanner({
      name: 'clamd',
      scan: async () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<ScanVerdict>((_, reject) => {
            failFirst = reject;
          });
        }
        return { verdict: 'clean' };
      },
    });
    const first = promoteAttachment({ disk: store, key, orgId: ORG, target: TARGET, policy: TEXT });
    await Bun.sleep(0);
    const second = await promoteAttachment({
      disk: store,
      key,
      orgId: ORG,
      target: TARGET,
      policy: TEXT,
    });
    failFirst(new TypeError('clamd timed out'));
    const error = await first.then(
      () => expect.unreachable('the first confirm was expected to be refused'),
      (reason: unknown) => reason,
    );
    expect(isUltimateError(error) ? error.code : error).toBe('X_STORAGE_SCAN_UNAVAILABLE');
    // The row the second confirm wrote still has its object.
    expect(second.key).toBe(attachmentKey(ORG, TARGET, 'u-1.txt'));
    expect(await store.exists(second.key)).toBe(true);
    // Neither attempt left a staged copy behind.
    expect((await store.list({ prefix: pendingPrefix(ORG) })).rows).toEqual([]);
  });

  test('a scanner that answers before reading the whole body has its stream cancelled', async () => {
    const store = disk();
    const key = pendingKey(ORG, 'u-2.txt');
    await store.put(key, encode('a plain note, long enough to need several chunks'), {
      contentType: 'text/plain',
    });
    let cancelled = false;
    const watched: StorageDriver = {
      ...store,
      async stream(streamed, options) {
        const bytes = (await store.get(streamed)).bytes;
        void options;
        let at = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (at >= bytes.byteLength) return controller.close();
            controller.enqueue(bytes.slice(at, at + 4));
            at += 4;
          },
          cancel() {
            cancelled = true;
          },
        });
      },
    };
    installUploadScanner({
      name: 'head-only',
      async scan({ body }) {
        const reader = body.getReader();
        await reader.read();
        reader.releaseLock();
        return { verdict: 'clean' };
      },
    });
    await promoteAttachment({ disk: watched, key, orgId: ORG, target: TARGET, policy: TEXT });
    expect(cancelled).toBe(true);
  });
});
