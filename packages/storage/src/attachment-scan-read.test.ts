// `promoteAttachment`'s scan step when the ATTACHED copy cannot be read for the scanner (an S3 GET
// reset, an etag-pinned read refused): that is "no verdict", exactly as a scanner that rejects — so
// the policy decides, the copy never stays unscanned on the row's key, and a cleanup that fails
// does not hide the refusal.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { attachmentKey, pendingKey, promoteAttachment } from './attachment';
import type { StorageDriver } from './driver';
import { memoryStorageDriver } from './driver-memory';
import { uploadPolicy } from './upload';
import { installUploadScanner, resetUploadScanner } from './upload-scanner';
import { memoryUploadScanner } from './upload-scanner-memory';

const ORG = 'org-1';
const TARGET = { entity: 'post', id: 'p-1', field: 'file' } as const;
const REFUSE = uploadPolicy({ allowedContentTypes: ['text/plain'] });
const ACCEPT = uploadPolicy({ allowedContentTypes: ['text/plain'], onScanUnavailable: 'accept' });

/** A memory disk whose `stream` fails — and, optionally, whose delete of an attempt copy does. */
function unreadable(options: { readonly failDelete?: boolean } = {}): StorageDriver {
  const store = memoryStorageDriver({
    signingSecret: 's',
    clock: frozenClock('2026-11-09T00:00:00Z'),
  });
  return {
    ...store,
    stream: () => Promise.reject(new TypeError('read ECONNRESET')),
    delete: (key: string) =>
      options.failDelete === true && key.startsWith(`org/${ORG}/pending/scan/`)
        ? Promise.reject(new TypeError('delete EACCES'))
        : store.delete(key),
  };
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the promotion was expected to be refused');
}

async function pending(store: StorageDriver, name: string): Promise<string> {
  const key = pendingKey(ORG, name);
  await store.put(key, new TextEncoder().encode('a plain note'), { contentType: 'text/plain' });
  return key;
}

afterEach(() => resetUploadScanner());

describe('promoteAttachment when the attached copy cannot be read for the scanner', () => {
  test('is X_STORAGE_SCAN_UNAVAILABLE, the copy is deleted and the upload stays pending', async () => {
    installUploadScanner(memoryUploadScanner());
    const store = unreadable();
    const key = await pending(store, 'u-1.txt');
    const error = await caught(() =>
      promoteAttachment({ disk: store, key, orgId: ORG, target: TARGET, policy: REFUSE }),
    );
    expect(isUltimateError(error) ? error.code : error).toBe('X_STORAGE_SCAN_UNAVAILABLE');
    expect(isUltimateError(error) ? error.cause : '').toContain('ECONNRESET');
    expect(await store.exists(attachmentKey(ORG, TARGET, 'u-1.txt'))).toBe(false);
    // Only the upload itself is left under pending/: the attempt copy was deleted.
    expect(
      (await store.list({ prefix: `org/${ORG}/pending/` })).rows.map((row) => row.key),
    ).toEqual([key]);
  });

  test("onScanUnavailable: 'accept' promotes it unscanned", async () => {
    installUploadScanner(memoryUploadScanner());
    const store = unreadable();
    const key = await pending(store, 'u-2.txt');
    const object = await promoteAttachment({
      disk: store,
      key,
      orgId: ORG,
      target: TARGET,
      policy: ACCEPT,
    });
    expect(object.key).toBe(attachmentKey(ORG, TARGET, 'u-2.txt'));
  });

  test('a delete of the copy that fails does not hide the refusal', async () => {
    installUploadScanner(memoryUploadScanner());
    const store = unreadable({ failDelete: true });
    const key = await pending(store, 'u-3.txt');
    const error = await caught(() =>
      promoteAttachment({ disk: store, key, orgId: ORG, target: TARGET, policy: REFUSE }),
    );
    expect(isUltimateError(error) ? error.code : error).toBe('X_STORAGE_SCAN_UNAVAILABLE');
  });
});
