// `promoteAttachment` against a scanner that answers `hold`: the out-of-band decision (a human
// review, a vendor's async sandbox) that the retired `quarantine: true` flow existed for. A held
// upload stays pending, nothing reaches the row's key, and no policy waves it through.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { attachmentKey, pendingKey, promoteAttachment } from './attachment';
import { memoryStorageDriver } from './driver-memory';
import { uploadPolicy } from './upload';
import { installUploadScanner, resetUploadScanner, type UploadScanner } from './upload-scanner';

const ORG = 'org-1';
const TARGET = { entity: 'post', id: 'p-1', field: 'file' } as const;
const TEXT = uploadPolicy({ allowedContentTypes: ['text/plain'] });
const disk = () =>
  memoryStorageDriver({ signingSecret: 's', clock: frozenClock('2026-11-10T00:00:00Z') });
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the promotion was expected to be refused');
}

/** The app's review queue: holds every upload a reviewer has not approved, keyed by upload. */
function reviewHold(approved: ReadonlySet<string>, asked: string[]): UploadScanner {
  return {
    name: 'review',
    holds: true,
    async scan(input) {
      asked.push(input.pendingKey);
      await input.body.cancel();
      return approved.has(input.pendingKey)
        ? { verdict: 'clean' }
        : { verdict: 'hold', reason: 'awaiting a moderator' };
    },
  };
}

afterEach(() => resetUploadScanner());

describe("promoteAttachment with a scanner that answers 'hold'", () => {
  test('refuses with X_STORAGE_QUARANTINED, keeps the upload pending, attaches nothing', async () => {
    const asked: string[] = [];
    installUploadScanner(reviewHold(new Set(), asked));
    const store = disk();
    const key = pendingKey(ORG, 'u-1.txt');
    await store.put(key, encode('a plain note'), { contentType: 'text/plain' });
    const error = await caught(() =>
      promoteAttachment({ disk: store, key, orgId: ORG, target: TARGET, policy: TEXT }),
    );
    expect(isUltimateError(error) ? error.code : error).toBe('X_STORAGE_QUARANTINED');
    expect(isUltimateError(error) ? error.meta : {}).toEqual({
      key,
      scanner: 'review',
      reason: 'awaiting a moderator',
    });
    expect(isUltimateError(error) ? error.cause : '').toContain('awaiting a moderator');
    // The scanner was told WHICH upload, not only the attempt copy's throwaway key.
    expect(asked).toEqual([key]);
    expect(await store.exists(key)).toBe(true);
    expect(await store.exists(attachmentKey(ORG, TARGET, 'u-1.txt'))).toBe(false);
    // The attempt copy is this call's scratch, and a hold deletes it: only the upload is left.
    expect((await store.list({ prefix: `org/${ORG}/pending/` })).rows.map((r) => r.key)).toEqual([
      key,
    ]);
  });

  test("is never waved through by onScanUnavailable: 'accept' — a hold is a verdict", async () => {
    installUploadScanner(reviewHold(new Set(), []));
    const store = disk();
    const key = pendingKey(ORG, 'u-2.txt');
    await store.put(key, encode('a plain note'), { contentType: 'text/plain' });
    const policy = uploadPolicy({
      allowedContentTypes: ['text/plain'],
      onScanUnavailable: 'accept',
    });
    const error = await caught(() =>
      promoteAttachment({ disk: store, key, orgId: ORG, target: TARGET, policy }),
    );
    expect(isUltimateError(error) ? error.code : error).toBe('X_STORAGE_QUARANTINED');
    expect(await store.exists(attachmentKey(ORG, TARGET, 'u-2.txt'))).toBe(false);
  });

  test('the same confirm promotes once the decision is clean — no key moves in between', async () => {
    const approved = new Set<string>();
    installUploadScanner(reviewHold(approved, []));
    const store = disk();
    const key = pendingKey(ORG, 'u-3.txt');
    await store.put(key, encode('a plain note'), { contentType: 'text/plain' });
    const promote = () =>
      promoteAttachment({ disk: store, key, orgId: ORG, target: TARGET, policy: TEXT });
    expect(await caught(promote)).toMatchObject({ code: 'X_STORAGE_QUARANTINED' });
    approved.add(key);
    const object = await promote();
    expect(object.key).toBe(attachmentKey(ORG, TARGET, 'u-3.txt'));
    expect(await store.exists(key)).toBe(false);
  });
});

describe('a scanner that holds', () => {
  test("refuses when it cannot answer, whatever onScanUnavailable says — 'accept' never promotes past a hold", async () => {
    // The review store is down: the scanner cannot say whether a moderator cleared the upload.
    installUploadScanner({
      name: 'review',
      holds: true,
      scan: () => Promise.reject(new TypeError('connect ECONNREFUSED 127.0.0.1:5432')),
    });
    const store = disk();
    const key = pendingKey(ORG, 'u-4.txt');
    await store.put(key, encode('a plain note'), { contentType: 'text/plain' });
    const policy = uploadPolicy({
      allowedContentTypes: ['text/plain'],
      onScanUnavailable: 'accept',
    });
    const error = await caught(() =>
      promoteAttachment({ disk: store, key, orgId: ORG, target: TARGET, policy }),
    );
    expect(isUltimateError(error) ? error.code : error).toBe('X_STORAGE_SCAN_UNAVAILABLE');
    expect(await store.exists(key)).toBe(true);
    expect(await store.exists(attachmentKey(ORG, TARGET, 'u-4.txt'))).toBe(false);
  });

  test('a hold from a scanner that never declared holds: true is refused as a bug, never attached', async () => {
    installUploadScanner({
      name: 'undeclared',
      async scan(input) {
        await input.body.cancel();
        return { verdict: 'hold', reason: 'awaiting a moderator' };
      },
    });
    const store = disk();
    const key = pendingKey(ORG, 'u-5.txt');
    await store.put(key, encode('a plain note'), { contentType: 'text/plain' });
    const error = await caught(() =>
      promoteAttachment({ disk: store, key, orgId: ORG, target: TARGET, policy: TEXT }),
    );
    expect(isUltimateError(error) ? error.code : error).toBe('X_INVARIANT');
    expect(isUltimateError(error) ? error.fix : '').toContain('holds: true');
    expect(await store.exists(key)).toBe(true);
    expect(await store.exists(attachmentKey(ORG, TARGET, 'u-5.txt'))).toBe(false);
  });
});
