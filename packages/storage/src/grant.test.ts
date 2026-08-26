import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { frozenClock } from '@ultimat3/core';
import { isPendingKey, isQuarantinedKey } from './attachment';
import type { StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { isStorageError } from './errors';
import { grantUpload } from './grant';
import { SIGNED_URL_PARAMS, verifySignedUrl } from './signed-url';
import { uploadPolicy } from './upload';

const SECRET = 'test-signing-secret';
const BASE = '/_storage/local';
const START = '2026-07-26T12:00:00.000Z';
const IMAGES = uploadPolicy({ maxBytes: 1024, allowedContentTypes: ['image/png', 'image/jpeg'] });

let root = '';
let disk: StorageDriver;
let clock: ReturnType<typeof frozenClock>;

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return isStorageError(error) ? error.code : `not-a-storage-error: ${String(error)}`;
  }
  return 'no-error-thrown';
}

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-storage-grant-`);
  clock = frozenClock(START);
  disk = localDriver({ root, signingSecret: SECRET, clock });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('grantUpload', () => {
  test('quarantine: true lands the key where promotion refuses it until a scan releases it', async () => {
    // Magic-byte sniffing closes stored XSS; it is not malware scanning, and `.docx` is a zip
    // by design. The framework ships the place a scan plugs in, never the scanner.
    const grant = await grantUpload({
      disk,
      orgId: 'org-1',
      request: { filename: 'report.png', contentType: 'image/png' },
      policy: IMAGES,
      quarantine: true,
      uploadId: () => 'u-1',
      clock,
    });
    expect(grant.key).toBe('org/org-1/pending/quarantine/u-1.png');
    expect(isQuarantinedKey(grant.key, 'org-1')).toBe(true);
    // Still inside `pending/`, so a never-scanned upload is still swept as an orphan.
    expect(isPendingKey(grant.key, 'org-1')).toBe(true);
  });

  test('without it the key is the ordinary pending one', async () => {
    const grant = await grantUpload({
      disk,
      orgId: 'org-1',
      request: { filename: 'report.png', contentType: 'image/png' },
      policy: IMAGES,
      uploadId: () => 'u-1',
      clock,
    });
    expect(grant.key).toBe('org/org-1/pending/u-1.png');
    expect(isQuarantinedKey(grant.key, 'org-1')).toBe(false);
  });

  test('refuses a type the policy never allowed, before anything is signed', async () => {
    const code = await codeOf(() =>
      grantUpload({
        disk,
        orgId: 'org-1',
        policy: IMAGES,
        clock,
        request: { filename: 'x.html', contentType: 'text/html' },
      }),
    );
    expect(code).toBe('X_STORAGE_TYPE_REJECTED');
  });

  test('refuses a declared size over the policy limit, so the bytes never move', async () => {
    const code = await codeOf(() =>
      grantUpload({
        disk,
        orgId: 'org-1',
        policy: IMAGES,
        clock,
        request: { filename: 'x.png', contentType: 'image/png', size: 4096 },
      }),
    );
    expect(code).toBe('X_STORAGE_TOO_LARGE');
  });

  // The client never names the key, so it cannot aim one at another tenant or at `..`.
  test('the key is derived, org-scoped, and keeps nothing of the filename but its extension', async () => {
    const grant = await grantUpload({
      disk,
      orgId: 'org-1',
      policy: IMAGES,
      clock,
      uploadId: () => 'u-1',
      request: { filename: '../../etc/passwd.PNG', contentType: 'IMAGE/PNG; charset=binary' },
    });
    expect(grant.key).toBe('org/org-1/pending/u-1.png');
    expect(grant.contentType).toBe('image/png');
    expect(grant.maxBytes).toBe(1024);
    expect(grant.method).toBe('PUT');
  });

  test('naming a target puts the key on the row instead of in pending', async () => {
    const grant = await grantUpload({
      disk,
      orgId: 'org-1',
      policy: IMAGES,
      clock,
      uploadId: () => 'u-1',
      target: { entity: 'post', id: 'p-1', field: 'cover' },
      request: { filename: 'a.png', contentType: 'image/png' },
    });
    expect(grant.key).toBe('org/org-1/post/p-1/cover/u-1.png');
  });

  test('the URL it hands out verifies, and carries the policy inside the signature', async () => {
    const grant = await grantUpload({
      disk,
      orgId: 'org-1',
      policy: IMAGES,
      clock,
      expiresInMs: 60_000,
      request: { filename: 'a.png', contentType: 'image/png' },
    });
    expect(grant.expiresAt).toBe(clock.now().getTime() + 60_000);

    const verified = await verifySignedUrl({
      url: grant.url,
      secret: SECRET,
      baseUrl: BASE,
      clock,
    });
    expect(verified.ok).toBe(true);
    expect(verified.ok ? verified.constraints.maxBytes : 0).toBe(1024);
    expect(verified.ok ? verified.constraints.contentType : '').toBe('image/png');
    expect(verified.ok ? verified.constraints.key : '').toBe(grant.key);
    expect(new URL(grant.url, 'http://x.invalid').searchParams.get(SIGNED_URL_PARAMS.method)).toBe(
      'PUT',
    );
  });

  test('two grants for one filename never collide', async () => {
    const request = { filename: 'a.png', contentType: 'image/png' };
    const first = await grantUpload({ disk, orgId: 'org-1', policy: IMAGES, clock, request });
    const second = await grantUpload({ disk, orgId: 'org-1', policy: IMAGES, clock, request });
    expect(first.key).not.toBe(second.key);
  });
});

/**
 * `expiresAt: clock.now().getTime() + NaN` is `NaN` in the grant this function RETURNS, and the
 * presigner one call down refuses in terms of `buildSignedUrl`'s own option — so the caller's
 * report named a function they never called. Refused here too, which is the layered form.
 */
describe('the grant TTL is screened where the caller writes it', () => {
  const grantWith = async (expiresInMs: number): Promise<string> =>
    codeOf(async () =>
      grantUpload({
        disk,
        orgId: 'org-1',
        request: { filename: 'report.png', contentType: 'image/png' },
        policy: IMAGES,
        uploadId: () => 'u-1',
        clock,
        expiresInMs,
      }),
    );

  test.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5])(
    'refuses expiresInMs %p, naming createUploadGrant',
    async (expiresInMs) => {
      const rendered = await grantWith(expiresInMs);
      expect(rendered).toContain('X_INVARIANT');
      expect(rendered).toContain('expiresInMs');
      expect(rendered).toContain('createUploadGrant');
    },
  );

  test('a real TTL still mints a grant that expires when it says', async () => {
    const grant = await grantUpload({
      disk,
      orgId: 'org-1',
      request: { filename: 'report.png', contentType: 'image/png' },
      policy: IMAGES,
      uploadId: () => 'u-1',
      clock,
      expiresInMs: 900_000,
    });
    expect(grant.expiresAt).toBe(new Date(START).getTime() + 900_000);
  });
});
