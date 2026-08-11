// The refusals first. Every test here is a request that must NOT be written: a forged signature,
// a stale one, one aimed at another tenant, one carrying more bytes or different bytes than the
// grant covered. The round trip at the bottom is what proves the refusals are not refusing
// everything.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { frozenClock } from '@ultimat3/core';
import { acceptSignedUpload, readSignedObject } from './accept';
import type { StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { isStorageError } from './errors';
import { grantUpload } from './grant';
import type { SignedUrlConstraints } from './signed-url';
import { canonicalRequest, SIGNED_URL_PARAMS, signConstraints } from './signed-url';
import { uploadPolicy } from './upload';

const SECRET = 'test-signing-secret';
const BASE = '/_storage/local';
const START = '2026-07-26T12:00:00.000Z';
const ORG = 'org-1';
const IMAGES = uploadPolicy({ maxBytes: 1024, allowedContentTypes: ['image/png', 'image/jpeg'] });

let root = '';
let disk: StorageDriver;
let clock: ReturnType<typeof frozenClock>;

/** Signature + a plausible IHDR chunk header: enough for a sniffer, not a decoder. */
function genuinePng(padding = 32): Uint8Array {
  const header = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ];
  return new Uint8Array([...header, ...new Array<number>(padding).fill(0x01)]);
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Not a StorageError is reported as itself — an assertion that reads "no-error" hides a pass. */
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return isStorageError(error) ? error.code : `not-a-storage-error: ${String(error)}`;
  }
  return 'no-error-thrown';
}

/** The code plus the `reason` in its meta — asserting the code alone cannot tell two gates apart. */
async function reasonOf(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await fn();
  } catch (error) {
    if (!isStorageError(error)) return { code: `not-a-storage-error: ${String(error)}` };
    return { code: error.code, reason: error.meta?.['reason'] };
  }
  return { code: 'no-error-thrown' };
}

/** A query string over constraints we signed ourselves, so only the checks after the HMAC apply. */
async function paramsFor(constraints: SignedUrlConstraints): Promise<string> {
  return new URLSearchParams({
    [SIGNED_URL_PARAMS.method]: constraints.method,
    [SIGNED_URL_PARAMS.expires]: String(constraints.expiresAt),
    [SIGNED_URL_PARAMS.maxBytes]: String(constraints.maxBytes),
    [SIGNED_URL_PARAMS.contentType]: String(constraints.contentType),
    [SIGNED_URL_PARAMS.signature]: await signConstraints(SECRET, constraints),
  }).toString();
}

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-storage-accept-`);
  clock = frozenClock(START);
  disk = localDriver({ root, signingSecret: SECRET, clock });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const putGrant = (size?: number): ReturnType<typeof grantUpload> =>
  grantUpload({
    disk,
    orgId: ORG,
    policy: IMAGES,
    clock,
    uploadId: () => 'upload-1',
    request: {
      filename: 'holiday.PNG',
      contentType: 'image/png',
      ...(size === undefined ? {} : { size }),
    },
  });

const accept = (url: string, bytes: Uint8Array, orgId = ORG): Promise<unknown> =>
  acceptSignedUpload({
    url,
    secret: SECRET,
    baseUrl: BASE,
    disk,
    orgId,
    bytes,
    declaredContentType: 'image/png',
    policy: IMAGES,
    clock,
  });

describe('acceptSignedUpload', () => {
  test('refuses a tampered signature and writes nothing', async () => {
    const grant = await putGrant();
    const tampered = grant.url.replace(/x-sig=([0-9a-f]{4})/, 'x-sig=dead');
    expect(tampered).not.toBe(grant.url);
    expect(await codeOf(() => accept(tampered, genuinePng()))).toBe('X_STORAGE_URL_INVALID');
    expect(await disk.exists(grant.key)).toBe(false);
  });

  // The constraints are IN the canonical string, so a client cannot widen what it was granted.
  test('refuses a widened maxBytes', async () => {
    const grant = await putGrant();
    const widened = grant.url.replace('x-max=1024', 'x-max=99999999');
    expect(widened).not.toBe(grant.url);
    expect(await codeOf(() => accept(widened, genuinePng()))).toBe('X_STORAGE_URL_INVALID');
  });

  test('refuses an expired grant', async () => {
    const grant = await putGrant();
    clock.advance(grant.expiresAt - clock.now().getTime() + 1);
    expect(await codeOf(() => accept(grant.url, genuinePng()))).toBe('X_STORAGE_URL_EXPIRED');
  });

  test('refuses more bytes than the signature granted', async () => {
    const grant = await putGrant();
    expect(await codeOf(() => accept(grant.url, genuinePng(4096)))).toBe('X_STORAGE_TOO_LARGE');
    expect(await disk.exists(grant.key)).toBe(false);
  });

  // Stored XSS: HTML bytes wearing the image/png the signature covers.
  test('refuses bytes whose magic disagrees with the signed type', async () => {
    const grant = await putGrant();
    const html = bytesOf('<!DOCTYPE html><script>fetch("/steal")</script>');
    expect(await codeOf(() => accept(grant.url, html))).toBe('X_STORAGE_TYPE_REJECTED');
    expect(await disk.exists(grant.key)).toBe(false);
  });

  test('refuses a Content-Type header the signature does not cover', async () => {
    const grant = await putGrant();
    const code = await codeOf(() =>
      acceptSignedUpload({
        url: grant.url,
        secret: SECRET,
        baseUrl: BASE,
        disk,
        orgId: ORG,
        bytes: genuinePng(),
        declaredContentType: 'text/html',
        policy: IMAGES,
        clock,
      }),
    );
    expect(code).toBe('X_STORAGE_URL_INVALID');
  });

  // The org lives in the key, so another tenant's object is unreachable — not merely unguessable.
  test('refuses a perfectly valid grant belonging to another org', async () => {
    const grant = await putGrant();
    expect(await codeOf(() => accept(grant.url, genuinePng(), 'org-2'))).toBe(
      'X_STORAGE_ORG_MISMATCH',
    );
    expect(await disk.exists(grant.key)).toBe(false);
  });

  // Two traversal shapes, caught by two different gates. Both must be refused, and the `reason`
  // is asserted so a future change cannot quietly swap one gate for "it failed somehow".
  test('a genuinely signed `..` key is refused: normalisation moves it out from under its own signature', async () => {
    const key = 'org/org-1/../../etc/passwd';
    const constraints = {
      key,
      method: 'PUT' as const,
      expiresAt: clock.now().getTime() + 60_000,
      maxBytes: 1024,
      contentType: 'image/png',
    };
    expect(canonicalRequest(constraints)).toContain(key);
    // `%2E%2E` does not survive `new URL()`: the path collapses to `/_storage/local/etc/passwd`,
    // so the key that gets verified is NOT the key that was signed, and the HMAC fires. The
    // traversal can therefore never reach a driver, whichever of the two gates gets there first.
    const forged = `${BASE}/${key.replaceAll('..', '%2E%2E')}?${await paramsFor(constraints)}`;
    expect(new URL(forged, 'http://storage.invalid').pathname).toBe('/_storage/local/etc/passwd');
    expect(await reasonOf(() => accept(forged, genuinePng()))).toEqual({
      code: 'X_STORAGE_URL_INVALID',
      reason: 'signature-mismatch',
    });
  });

  test('a genuinely signed key with a backslash is refused as unsafe, signature and all', async () => {
    const key = `org/org-1/a${String.fromCharCode(92)}b.png`;
    const constraints = {
      key,
      method: 'PUT' as const,
      expiresAt: clock.now().getTime() + 60_000,
      maxBytes: 1024,
      contentType: 'image/png',
    };
    const path = key.split('/').map(encodeURIComponent).join('/');
    const forged = `${BASE}/${path}?${await paramsFor(constraints)}`;
    expect(await reasonOf(() => accept(forged, genuinePng()))).toEqual({
      code: 'X_STORAGE_URL_INVALID',
      reason: 'unsafe-key',
    });
  });

  test('refuses a PUT grant replayed as a download', async () => {
    const grant = await putGrant();
    const code = await codeOf(() =>
      readSignedObject({ url: grant.url, secret: SECRET, baseUrl: BASE, disk, orgId: ORG, clock }),
    );
    expect(code).toBe('X_STORAGE_URL_INVALID');
  });

  test('accepts the granted bytes and reads them back through the GET half', async () => {
    const grant = await putGrant(48);
    expect(grant.key).toBe('org/org-1/pending/upload-1.png');
    const stored = await accept(grant.url, genuinePng());
    expect(stored).toMatchObject({ key: grant.key, contentType: 'image/png', size: 48 });

    const url = await disk.signedUrl(grant.key, { method: 'GET' });
    const read = await readSignedObject({
      url,
      secret: SECRET,
      baseUrl: BASE,
      disk,
      orgId: ORG,
      clock,
    });
    expect(read.object.contentType).toBe('image/png');
    expect(read.bytes.byteLength).toBe(48);
  });

  test('a download for another org is refused even with a valid signature', async () => {
    const grant = await putGrant();
    await accept(grant.url, genuinePng());
    const url = await disk.signedUrl(grant.key, { method: 'GET' });
    const code = await codeOf(() =>
      readSignedObject({ url, secret: SECRET, baseUrl: BASE, disk, orgId: 'org-2', clock }),
    );
    expect(code).toBe('X_STORAGE_ORG_MISMATCH');
  });
});
