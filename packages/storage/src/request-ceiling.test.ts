// A single signed PUT to the local or memory disk is one request to THIS process, so it cannot be
// larger than the server reads in one request. Refused when the URL is signed, naming the multipart
// grant — not after the uploader has sent the bytes and met `X_BODY_TOO_LARGE`.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { localDriver } from './driver-local';
import { memoryStorageDriver } from './driver-memory';
import { grantUpload } from './grant';
import { grantMultipart } from './grant-multipart';
import { uploadPolicy } from './upload';

const MIB = 1024 * 1024;
const policy = uploadPolicy({ maxBytes: 64 * MIB, allowedContentTypes: ['application/pdf'] });
const disks = () => [
  localDriver({ root: '/tmp/never-written', signingSecret: 's', maxRequestBytes: 8 * MIB }),
  memoryStorageDriver({ signingSecret: 's', maxRequestBytes: 8 * MIB }),
];
const request = (size: number) => ({ filename: 'a.pdf', contentType: 'application/pdf', size });

describe('maxRequestBytes', () => {
  test('a single-request grant past the server’s request ceiling is refused, naming multipart', async () => {
    for (const disk of disks()) {
      const caught = await grantUpload({
        disk,
        orgId: 'o1',
        policy,
        request: request(9 * MIB),
      }).catch((error: unknown) => error);
      expect(caught).toBeUltimateError('X_STORAGE_TOO_LARGE');
      expect(isUltimateError(caught) ? caught.fix : '').toContain('grantMultipart');
    }
  });

  test('at the ceiling it signs, and in parts any size the policy allows still signs', async () => {
    for (const disk of disks()) {
      const grant = await grantUpload({ disk, orgId: 'o1', policy, request: request(8 * MIB) });
      expect(grant.url).toContain('x-max=');
      const parts = await grantMultipart({ disk, orgId: 'o1', policy, request: request(40 * MIB) });
      expect(parts.uploadId).not.toBe('');
    }
  });

  test('a reader is asked at each signing: a ceiling declared after the disk was built holds', async () => {
    let ceiling = 64 * MIB;
    const disk = memoryStorageDriver({ signingSecret: 's', maxRequestBytes: () => ceiling });
    await grantUpload({ disk, orgId: 'o1', policy, request: request(9 * MIB) });
    ceiling = 8 * MIB;
    const caught = await grantUpload({
      disk,
      orgId: 'o1',
      policy,
      request: request(9 * MIB),
    }).catch((error: unknown) => error);
    expect(caught).toBeUltimateError('X_STORAGE_TOO_LARGE');
  });
});
