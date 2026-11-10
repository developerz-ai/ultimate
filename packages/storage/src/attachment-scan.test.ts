// `promoteAttachment` with an `uploadScanner` installed: the bytes that land on the row's key are
// scanned there, an infected upload is deleted and refused, and a scanner that cannot answer
// refuses the promotion unless the upload's policy says the app accepts unscanned files.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { attachmentKey, pendingKey, promoteAttachment } from './attachment';
import { memoryStorageDriver } from './driver-memory';
import { uploadPolicy } from './upload';
import { installUploadScanner, resetUploadScanner, type UploadScanner } from './upload-scanner';
import { EICAR_TEST_STRING, memoryUploadScanner } from './upload-scanner-memory';

const ORG = 'org-1';
const TARGET = { entity: 'post', id: 'p-1', field: 'file' } as const;
const TEXT = uploadPolicy({ allowedContentTypes: ['text/plain'] });
const disk = () =>
  memoryStorageDriver({ signingSecret: 's', clock: frozenClock('2026-11-09T00:00:00Z') });
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the promotion was expected to be refused');
}

const down: UploadScanner = {
  name: 'clamd',
  scan: () => Promise.reject(new TypeError('connect ECONNREFUSED 127.0.0.1:3310')),
};

afterEach(() => resetUploadScanner());

describe('promoteAttachment with an uploadScanner installed', () => {
  test('a clean upload is scanned and promoted', async () => {
    const seen: string[] = [];
    installUploadScanner({
      name: 'spy',
      scan: async (input) => {
        seen.push(input.key);
        return memoryUploadScanner().scan(input);
      },
    });
    const store = disk();
    const key = pendingKey(ORG, 'u-1.txt');
    await store.put(key, encode('a plain note'), { contentType: 'text/plain' });
    const object = await promoteAttachment({
      disk: store,
      key,
      orgId: ORG,
      target: TARGET,
      policy: TEXT,
    });
    expect(object.key).toBe(attachmentKey(ORG, TARGET, 'u-1.txt'));
    // A server-named attempt copy is what is scanned — no presigned URL reaches it, and it is never
    // the row's key — and it is gone once its bytes are attached.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toStartWith(`org/${ORG}/pending/scan/`);
    expect(seen[0]).toEndWith('-u-1.txt');
    expect(await store.exists(seen[0] ?? '')).toBe(false);
  });

  test('an infected upload is refused, and neither the pending nor the attached key keeps it', async () => {
    installUploadScanner(memoryUploadScanner());
    const store = disk();
    const key = pendingKey(ORG, 'u-2.txt');
    await store.put(key, encode(EICAR_TEST_STRING), { contentType: 'text/plain' });
    const error = await caught(() =>
      promoteAttachment({ disk: store, key, orgId: ORG, target: TARGET, policy: TEXT }),
    );
    expect(isUltimateError(error) ? error.code : error).toBe('X_STORAGE_UPLOAD_INFECTED');
    expect(isUltimateError(error) ? error.meta : {}).toMatchObject({
      signature: 'EICAR-Test-File',
      scanner: 'memory',
    });
    expect(await store.exists(key)).toBe(false);
    expect(await store.exists(attachmentKey(ORG, TARGET, 'u-2.txt'))).toBe(false);
  });

  test('a scanner that cannot answer refuses by default, and the upload stays pending', async () => {
    installUploadScanner(down);
    const store = disk();
    const key = pendingKey(ORG, 'u-3.txt');
    await store.put(key, encode('a plain note'), { contentType: 'text/plain' });
    const error = await caught(() =>
      promoteAttachment({ disk: store, key, orgId: ORG, target: TARGET, policy: TEXT }),
    );
    expect(isUltimateError(error) ? error.code : error).toBe('X_STORAGE_SCAN_UNAVAILABLE');
    expect(isUltimateError(error) ? error.cause : '').toContain('ECONNREFUSED');
    // Retryable: the pending upload is still there, the half-made attached copy is not.
    expect(await store.exists(key)).toBe(true);
    expect(await store.exists(attachmentKey(ORG, TARGET, 'u-3.txt'))).toBe(false);
  });

  test("onScanUnavailable: 'accept' promotes unscanned when the scanner cannot answer", async () => {
    installUploadScanner(down);
    const store = disk();
    const key = pendingKey(ORG, 'u-4.txt');
    await store.put(key, encode('a plain note'), { contentType: 'text/plain' });
    const policy = uploadPolicy({
      allowedContentTypes: ['text/plain'],
      onScanUnavailable: 'accept',
    });
    const object = await promoteAttachment({
      disk: store,
      key,
      orgId: ORG,
      target: TARGET,
      policy,
    });
    expect(object.key).toBe(attachmentKey(ORG, TARGET, 'u-4.txt'));
  });

  test('an infected verdict is never overridden by onScanUnavailable', async () => {
    installUploadScanner(memoryUploadScanner());
    const store = disk();
    const key = pendingKey(ORG, 'u-5.txt');
    await store.put(key, encode(EICAR_TEST_STRING), { contentType: 'text/plain' });
    const policy = uploadPolicy({
      allowedContentTypes: ['text/plain'],
      onScanUnavailable: 'accept',
    });
    const error = await caught(() =>
      promoteAttachment({ disk: store, key, orgId: ORG, target: TARGET, policy }),
    );
    expect(isUltimateError(error) ? error.code : error).toBe('X_STORAGE_UPLOAD_INFECTED');
  });

  test('with no scanner installed, an EICAR upload promotes exactly as before', async () => {
    const store = disk();
    const key = pendingKey(ORG, 'u-6.txt');
    await store.put(key, encode(EICAR_TEST_STRING), { contentType: 'text/plain' });
    const object = await promoteAttachment({
      disk: store,
      key,
      orgId: ORG,
      target: TARGET,
      policy: TEXT,
    });
    expect(await store.exists(object.key)).toBe(true);
  });

  test('uploadPolicy refuses an onScanUnavailable that is neither refuse nor accept', () => {
    expect(() => uploadPolicy({ onScanUnavailable: 'ignore' as unknown as 'accept' })).toThrow(
      /onScanUnavailable/,
    );
  });
});
