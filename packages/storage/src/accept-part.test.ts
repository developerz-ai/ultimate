// A part URL and a single PUT's URL are two capabilities: each is refused at the other's door, and
// neither the session nor the part number can be edited without breaking the signature.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { acceptSignedUpload } from './accept';
import { acceptSignedPart } from './accept-part';
import { memoryStorageDriver } from './driver-memory';
import { bytesOf, catchError, codeOf } from './driver-s3-fixture';
import { grantUpload } from './grant';
import { grantMultipart, signPart } from './grant-multipart';
import { SIGNED_URL_PARAMS } from './signed-url';
import { uploadPolicy } from './upload';

const clock = frozenClock('2026-07-26T12:00:00.000Z');
const policy = uploadPolicy({ maxBytes: 1 << 30, allowedContentTypes: ['text/plain'] });
const request = { filename: 'a.txt', contentType: 'text/plain', size: 64 << 20 };

const setup = async () => {
  const disk = memoryStorageDriver({ signingSecret: 'test-secret', clock });
  const grant = await grantMultipart({ disk, orgId: 'org-1', request, policy, clock });
  const session = { disk, orgId: 'org-1', key: grant.key, uploadId: grant.uploadId };
  const url = await signPart({ ...session, policy, partNumber: 2, size: 4 });
  return { disk, grant, session, url };
};

describe('acceptSignedPart', () => {
  test('stores the signed part, and only within the signed length', async () => {
    const { disk, grant, url } = await setup();
    const part = await acceptSignedPart({ url, disk, orgId: 'org-1', bytes: bytesOf('abcd') });
    expect(part).toMatchObject({ partNumber: 2, size: 4 });
    const over = await catchError(() =>
      acceptSignedPart({ url, disk, orgId: 'org-1', bytes: bytesOf('abcde') }),
    );
    expect(codeOf(over)).toBe('X_STORAGE_TOO_LARGE');
    expect((await disk.multipart?.listParts(grant.key, grant.uploadId))?.length).toBe(1);
  });

  test('an edited part number or session is a signature mismatch', async () => {
    const { disk, url } = await setup();
    for (const [name, value] of [
      [SIGNED_URL_PARAMS.partNumber, '3'],
      [SIGNED_URL_PARAMS.uploadId, 'another-upload'],
    ] as const) {
      const edited = new URL(url, 'http://app.test');
      edited.searchParams.set(name, value);
      const refused = await catchError(() =>
        acceptSignedPart({
          url: `${edited.pathname}${edited.search}`,
          disk,
          orgId: 'org-1',
          bytes: bytesOf('abcd'),
        }),
      );
      expect(codeOf(refused)).toBe('X_STORAGE_URL_INVALID');
    }
  });

  test('a part URL never writes the object, and an object URL never writes a part', async () => {
    const { disk, grant, url } = await setup();
    const asObject = await catchError(() =>
      acceptSignedUpload({ url, disk, orgId: 'org-1', bytes: bytesOf('abcd'), policy }),
    );
    expect(codeOf(asObject)).toBe('X_STORAGE_URL_INVALID');
    expect(await disk.stat(grant.key)).toBeUndefined();
    const single = await grantUpload({
      disk,
      orgId: 'org-1',
      request: { ...request, size: 4 },
      policy,
      clock,
    });
    const asPart = await catchError(() =>
      acceptSignedPart({ url: single.url, disk, orgId: 'org-1', bytes: bytesOf('abcd') }),
    );
    expect(codeOf(asPart)).toBe('X_STORAGE_URL_INVALID');
  });

  test('a part for a session that is not open is unknown, and another tenant is refused', async () => {
    const { disk, session, url } = await setup();
    const foreign = await catchError(() =>
      acceptSignedPart({ url, disk, orgId: 'org-2', bytes: bytesOf('abcd') }),
    );
    expect(codeOf(foreign)).toBe('X_STORAGE_ORG_MISMATCH');
    await disk.multipart?.abort(session.key, session.uploadId);
    const closed = await catchError(() =>
      acceptSignedPart({ url, disk, orgId: 'org-1', bytes: bytesOf('abcd') }),
    );
    expect(codeOf(closed)).toBe('X_STORAGE_UPLOAD_UNKNOWN');
  });
});

describe('acceptSignedPart holds a part to its signed length', () => {
  test('a part shorter than its signed length is refused, as s3 refuses it', async () => {
    const { disk, grant, url } = await setup();
    const short = await catchError(() =>
      acceptSignedPart({ url, disk, orgId: 'org-1', bytes: bytesOf('abc') }),
    );
    expect(codeOf(short)).toBe('X_STORAGE_URL_INVALID');
    expect((await disk.multipart?.listParts(grant.key, grant.uploadId))?.length).toBe(0);
  });
});
