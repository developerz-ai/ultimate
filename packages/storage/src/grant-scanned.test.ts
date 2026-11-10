// A grant aimed straight at a row's key never passes through `promoteAttachment`, so with an
// `uploadScanner` installed it would land bytes nothing scanned. Refused at the grant, for both
// grants (`decideGrant` is shared), before anything is signed.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { memoryStorageDriver } from './driver-memory';
import { grantUpload } from './grant';
import { grantMultipart } from './grant-multipart';
import { uploadPolicy } from './upload';
import { installUploadScanner, resetUploadScanner } from './upload-scanner';
import { memoryUploadScanner } from './upload-scanner-memory';

const disk = () =>
  memoryStorageDriver({ signingSecret: 's', clock: frozenClock('2026-11-10T00:00:00Z') });
const TARGET = { entity: 'post', id: 'p-1', field: 'cover' } as const;
const POLICY = uploadPolicy({ maxBytes: 64 * 1024 * 1024, allowedContentTypes: ['image/png'] });
const REQUEST = { filename: 'a.png', contentType: 'image/png', size: 1024 } as const;

async function codeOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return isUltimateError(error) ? error.code : error;
  }
  return expect.unreachable('the grant was expected to be refused');
}

afterEach(() => resetUploadScanner());

describe('a targeted grant with an uploadScanner installed', () => {
  test('grantUpload refuses it: the bytes would reach the row with no scan', async () => {
    installUploadScanner(memoryUploadScanner());
    const store = disk();
    expect(
      await codeOf(() =>
        grantUpload({ disk: store, orgId: 'o1', request: REQUEST, policy: POLICY, target: TARGET }),
      ),
    ).toBe('X_STORAGE_TARGET_UNSCANNED');
  });

  test('grantMultipart refuses it the same way', async () => {
    installUploadScanner(memoryUploadScanner());
    const store = disk();
    expect(
      await codeOf(() =>
        grantMultipart({
          disk: store,
          orgId: 'o1',
          request: REQUEST,
          policy: POLICY,
          target: TARGET,
        }),
      ),
    ).toBe('X_STORAGE_TARGET_UNSCANNED');
  });

  test('an untargeted grant is untouched, and so is a targeted one with no scanner', async () => {
    const store = disk();
    const direct = await grantUpload({
      disk: store,
      orgId: 'o1',
      request: REQUEST,
      policy: POLICY,
      target: TARGET,
    });
    expect(direct.key).toStartWith('org/o1/post/p-1/cover/');
    installUploadScanner(memoryUploadScanner());
    const pending = await grantUpload({
      disk: store,
      orgId: 'o1',
      request: REQUEST,
      policy: POLICY,
    });
    expect(pending.key).toStartWith('org/o1/pending/');
  });
});
