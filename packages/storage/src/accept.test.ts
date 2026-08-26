// The refusals first. Every test here is a request that must NOT be written: a forged signature,
// a stale one, one aimed at another tenant, one carrying more bytes or different bytes than the
// grant covered. The round trip at the bottom is what proves the refusals are not refusing
// everything.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove — `mkdtemp` and `rm` have no
// `Bun.*` equivalent, and this suite needs a real directory per run. Delete this import the day
// one lands.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask the platform where its
// temporary directory is.
import { tmpdir } from 'node:os';
import { frozenClock } from '@ultimat3/core';
import { acceptSignedUpload, readSignedObject } from './accept';
import type { StorageDriver } from './driver';
import { sha256Base64 } from './driver';
import { localDriver } from './driver-local';
import { isStorageError } from './errors';
import { grantUpload } from './grant';
import type { SignedUrlConstraints } from './signed-url';
import { canonicalRequest, SIGNED_URL_PARAMS, signConstraints } from './signed-url';
import { defineStorage, resetStorage } from './storage';
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

/**
 * The documented pair, with NO `baseUrl` on either call. `localDriver` signs under
 * `/_storage/<driver>` and the accept side has to arrive at the same base from the disk it was
 * handed — a second default is a genuine URL that verifies nowhere.
 */
describe('the default base', () => {
  test('a grant minted with no baseUrl verifies with no baseUrl', async () => {
    const grant = await putGrant(48);
    const stored = await acceptSignedUpload({
      url: grant.url,
      secret: SECRET,
      disk,
      orgId: ORG,
      bytes: genuinePng(),
      declaredContentType: 'image/png',
      policy: IMAGES,
      clock,
    });
    expect(stored.key).toBe(grant.key);

    const url = await disk.signedUrl(grant.key, { method: 'GET' });
    const read = await readSignedObject({ url, secret: SECRET, disk, orgId: ORG, clock });
    expect(read.bytes.byteLength).toBe(48);
  });
});

/** `requireChecksum` governs a path only if a request can carry a checksum at all. */
describe('requireChecksum', () => {
  const CHECKED = uploadPolicy({
    maxBytes: 1024,
    allowedContentTypes: ['image/png'],
    requireChecksum: true,
  });

  const acceptWith = (url: string, bytes: Uint8Array, checksum?: string): Promise<unknown> =>
    acceptSignedUpload({
      url,
      secret: SECRET,
      disk,
      orgId: ORG,
      bytes,
      declaredContentType: 'image/png',
      policy: CHECKED,
      clock,
      ...(checksum === undefined ? {} : { checksum }),
    });

  test('accepts an upload whose declared checksum matches the bytes', async () => {
    const grant = await putGrant(48);
    const bytes = genuinePng();
    const stored = await acceptWith(grant.url, bytes, sha256Base64(bytes));
    expect(stored).toMatchObject({ key: grant.key, contentType: 'image/png', size: 48 });
    expect(await disk.exists(grant.key)).toBe(true);
  });

  // `meta.declared` is asserted, not just the code: a build that dropped the field on the floor
  // would refuse this upload too, as "declared none" — the same code for a different reason.
  test('refuses an upload whose declared checksum is a lie', async () => {
    const grant = await putGrant(48);
    let declared: unknown = 'no-error-thrown';
    try {
      await acceptWith(grant.url, genuinePng(), 'not-the-hash');
    } catch (error) {
      declared = isStorageError(error) ? error.meta?.['declared'] : String(error);
    }
    expect(declared).toBe('not-the-hash');
    expect(await disk.exists(grant.key)).toBe(false);
  });

  test('still refuses an upload that declares none, which is what the policy is for', async () => {
    const grant = await putGrant(48);
    expect(await codeOf(() => acceptWith(grant.url, genuinePng()))).toBe(
      'X_STORAGE_CHECKSUM_MISMATCH',
    );
  });
});

/** The code plus `meta.reason` flattened, so two gates cannot pass for each other. */
async function outcomeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (!isStorageError(error)) return `not-a-storage-error: ${String(error)}`;
    const reason = error.meta?.['reason'];
    return typeof reason === 'string' ? `${error.code}:${reason}` : error.code;
  }
  return 'no-error-thrown';
}

/** A GET signed with the REAL secret, for any key — the attacker this gate must survive. */
async function forgedGet(key: string, encodeWhole = false): Promise<string> {
  const constraints = {
    key,
    method: 'GET' as const,
    expiresAt: clock.now().getTime() + 60_000,
    maxBytes: undefined,
    contentType: undefined,
  };
  const params = new URLSearchParams({
    [SIGNED_URL_PARAMS.method]: 'GET',
    [SIGNED_URL_PARAMS.expires]: String(constraints.expiresAt),
    [SIGNED_URL_PARAMS.signature]: await signConstraints(SECRET, constraints),
  });
  const path = encodeWhole
    ? encodeURIComponent(key)
    : key.split('/').map(encodeURIComponent).join('/');
  return `${BASE}/${path}?${params.toString()}`;
}

describe('keys outside the tenant namespace', () => {
  test("an app's own shared asset is readable through a signed URL", async () => {
    await disk.put('brand/logo.png', genuinePng(), { contentType: 'image/png' });
    const url = await disk.signedUrl('brand/logo.png');
    const read = await readSignedObject({ url, secret: SECRET, disk, orgId: ORG, clock });
    expect(read.bytes.byteLength).toBe(48);
  });

  // Every spoof is signed with the REAL secret: a refusal that leaned on the HMAC would prove
  // nothing about the tenant gate itself. `org-1` is the actor throughout.
  const SPOOFS: readonly (readonly [string, string])[] = [
    ['org/org-2/secret.png', 'X_STORAGE_ORG_MISMATCH'],
    // Case: `Org/` and `org/` are ONE directory on a case-insensitive filesystem (APFS, NTFS),
    // so a case-folded prefix that read as "not tenant-scoped" would be a cross-tenant read.
    ['Org/org-2/secret.png', 'X_STORAGE_ORG_MISMATCH'],
    ['ORG/org-1/secret.png', 'X_STORAGE_ORG_MISMATCH'],
    // The prefix ends in a slash, so a longer org id may not borrow a shorter one's namespace.
    ['org/org-1x/secret.png', 'X_STORAGE_ORG_MISMATCH'],
    // `new URL()` normalises the traversal away, so the key verified is not the key signed.
    ['org/org-1/../../org-2/secret.png', 'X_STORAGE_URL_INVALID:signature-mismatch'],
    ['org/org-1/./secret.png', 'X_STORAGE_URL_INVALID:signature-mismatch'],
    // The sidecar namespace: reachable only if the org gate stopped being what refused it.
    ['.meta/org/org-2/secret.png.json', 'X_STORAGE_URL_INVALID:unsafe-key'],
    ['/org/org-2/secret.png', 'X_STORAGE_URL_INVALID:unsafe-key'],
    ['org/org-2//secret.png', 'X_STORAGE_URL_INVALID:unsafe-key'],
  ];

  for (const [key, expected] of SPOOFS) {
    test(`refuses a genuinely signed "${key}"`, async () => {
      const url = await forgedGet(key);
      expect(
        await outcomeOf(() => readSignedObject({ url, secret: SECRET, disk, orgId: ORG, clock })),
      ).toBe(expected);
    });
  }

  test('a percent-encoded separator decodes before the tenant gate, never after', async () => {
    const url = await forgedGet('org/org-2/secret.png', true);
    expect(new URL(url, 'http://storage.invalid').pathname).toContain('%2F');
    expect(
      await outcomeOf(() => readSignedObject({ url, secret: SECRET, disk, orgId: ORG, clock })),
    ).toBe('X_STORAGE_ORG_MISMATCH');
  });

  // A homoglyph prefix is not tenant-scoped and must not resolve to the object it imitates:
  // no filesystem folds Cyrillic `о` onto ASCII `o`, so this is a different key entirely.
  test('a homoglyph org prefix reads no object at all', async () => {
    await disk.put('org/org-2/secret.png', genuinePng(), { contentType: 'image/png' });
    const url = await forgedGet('оrg/org-2/secret.png');
    expect(
      await outcomeOf(() => readSignedObject({ url, secret: SECRET, disk, orgId: ORG, clock })),
    ).toBe('X_STORAGE_NOT_FOUND');
  });
});

// The mounted route is `/_storage/:disk/*key` and resolves `:disk` through the REGISTRY, so the
// segment a disk mints under has to be the key it was registered under. It was the DRIVER's name
// on both halves — minting and verifying agreed with each other and both disagreed with the
// route, so every disk not literally named `local` 404'd its own signed URLs.
describe('the disk segment is the REGISTERED name, never the driver kind', () => {
  test('a disk registered as "uploads" mints under /_storage/uploads and reads back', async () => {
    resetStorage();
    try {
      defineStorage({ disks: { uploads: disk } });
      await disk.put('brand/logo.png', genuinePng(), { contentType: 'image/png' });
      const url = await disk.signedUrl('brand/logo.png', { method: 'GET' });
      expect(new URL(url, 'http://storage.invalid').pathname).toBe(
        '/_storage/uploads/brand/logo.png',
      );
      // No `baseUrl`: the default is the base the disk itself signs under, so the two halves
      // cannot drift apart the way a second `signedUrlBaseFor()` call let them.
      const read = await readSignedObject({ url, secret: SECRET, disk, orgId: ORG, clock });
      expect(read.object.contentType).toBe('image/png');
    } finally {
      resetStorage();
    }
  });

  test('an unregistered disk still mints under its driver name, as it always did', async () => {
    resetStorage();
    const url = await localDriver({ root, signingSecret: SECRET, clock }).signedUrl('a.png');
    expect(new URL(url, 'http://storage.invalid').pathname).toBe('/_storage/local/a.png');
  });

  test('an explicit baseUrl outranks the registration — it is the operator saying where', async () => {
    resetStorage();
    try {
      const mounted = localDriver({ root, signingSecret: SECRET, clock, baseUrl: '/files/pics' });
      defineStorage({ disks: { uploads: mounted } });
      const url = await mounted.signedUrl('a.png');
      expect(new URL(url, 'http://storage.invalid').pathname).toBe('/files/pics/a.png');
    } finally {
      resetStorage();
    }
  });
});
