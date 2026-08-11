// The browser half. The transport is injected, never real: the test preload seals the network,
// and a helper that only works against a live socket is a helper nobody can regression-test.

import { describe, expect, test } from 'bun:test';
import { isStorageError, uploadFailed } from './errors';
import type { UploadGrant, UploadRequest } from './grant';
import type { SignedPutInput, UploadProgress, UploadSource } from './upload-client';
import { uploadFile } from './upload-client';

const GRANT: UploadGrant = {
  key: 'org/org-1/pending/u-1.png',
  url: '/_storage/local/org/org-1/pending/u-1.png?x-sig=abc',
  method: 'PUT',
  contentType: 'image/png',
  maxBytes: 1024,
  expiresAt: 1_784_000_000_000,
};

const fileOf = (bytes: number, name = 'holiday.png', type = 'image/png'): UploadSource =>
  Object.assign(new Blob([new Uint8Array(bytes)], { type }), { name }) as UploadSource;

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return isStorageError(error) ? error.code : `not-a-storage-error: ${String(error)}`;
  }
  return 'no-error-thrown';
}

describe('uploadFile', () => {
  test('asks for a grant, PUTs at it, and answers with the key — never the URL', async () => {
    const seen: (UploadRequest | SignedPutInput)[] = [];
    const result = await uploadFile({
      file: fileOf(64),
      grant: async (request) => {
        seen.push(request);
        return GRANT;
      },
      put: async (input) => {
        seen.push(input);
      },
    });
    expect(seen[0]).toEqual({ filename: 'holiday.png', contentType: 'image/png', size: 64 });
    expect((seen[1] as SignedPutInput).url).toBe(GRANT.url);
    // The type sent is the one the SIGNATURE covers, not the one the browser guessed.
    expect((seen[1] as SignedPutInput).contentType).toBe('image/png');
    expect(result).toEqual({ key: GRANT.key, contentType: 'image/png', size: 64 });
    expect(Object.keys(result)).not.toContain('url');
  });

  // The server counts the bytes again on arrival; this only spares the user the whole transfer.
  test('refuses a file over the grant before a byte moves', async () => {
    let put = 0;
    const code = await codeOf(() =>
      uploadFile({
        file: fileOf(4096),
        grant: async () => GRANT,
        put: async () => {
          put += 1;
        },
      }),
    );
    expect(code).toBe('X_STORAGE_TOO_LARGE');
    expect(put).toBe(0);
  });

  test('a refused PUT surfaces as X_STORAGE_UPLOAD_FAILED, not a bare rejection', async () => {
    const code = await codeOf(() =>
      uploadFile({
        file: fileOf(64),
        grant: async () => GRANT,
        put: async () => {
          throw uploadFailed('/_storage/local/org/org-1/pending/u-1.png', 413, 'too large');
        },
      }),
    );
    expect(code).toBe('X_STORAGE_UPLOAD_FAILED');
  });

  test('progress reaches the caller unchanged', async () => {
    const ticks: UploadProgress[] = [];
    await uploadFile({
      file: fileOf(100),
      grant: async () => GRANT,
      onProgress: (progress) => ticks.push(progress),
      put: async (input) => {
        input.onProgress?.({ loaded: 50, total: 100, ratio: 0.5 });
        input.onProgress?.({ loaded: 100, total: 100, ratio: 1 });
      },
    });
    expect(ticks.map((tick) => tick.ratio)).toEqual([0.5, 1]);
  });
});
