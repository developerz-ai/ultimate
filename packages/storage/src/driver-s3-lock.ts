// Single responsibility: the two s3 calls `Bun.S3Client` cannot make — a PUT carrying user
// metadata, `Cache-Control` and Object Lock headers, and the `?retention` / `?legal-hold` reads
// behind `retentionOf` — over the signed wire in `driver-s3-signed.ts`, answered in this package's
// vocabulary. A plain `put()` never comes here: it stays on the Bun client.

import { assert, describeValue } from '@ultimat3/core';
import { DEFAULT_CONTENT_TYPE, type PutOptions } from './driver';
import { type S3Refusal, type S3WireOptions, sendSigned, xmlField } from './driver-s3-signed';
import { isRetentionMode, type ObjectLock } from './object-lock';

/** RFC 9110 `token` — the only bytes an `x-amz-meta-<name>` header name may carry. */
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Printable ASCII: S3 stores a metadata value as a header, and a CR or a non-ASCII byte is not one. */
const HEADER_VALUE = /^[\x20-\x7e]*$/;

/** The options only the signed PUT can carry. Any one of them routes the put off the Bun client. */
export function needsSignedPut(options: PutOptions | undefined): boolean {
  return (
    options?.metadata !== undefined ||
    options?.cacheControl !== undefined ||
    options?.retention !== undefined ||
    options?.legalHold !== undefined
  );
}

/** Every header the signed PUT sends beyond the signer's own, screened before a byte moves. */
export function putHeaders(bytes: Uint8Array, options: PutOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? DEFAULT_CONTENT_TYPE,
    // Required by S3 on any PUT that sets a retention, and an integrity check on every other one:
    // a body that changed in flight is `BadDigest`, never a stored object.
    'content-md5': new Bun.CryptoHasher('md5').update(bytes).digest('base64'),
  };
  if (options.cacheControl !== undefined) {
    assert(
      HEADER_VALUE.test(options.cacheControl),
      `put() on the s3 disk was given a cacheControl that cannot travel as a header (${describeValue(options.cacheControl)})`,
      "put(key, body, { cacheControl: 'public, max-age=3600' }) — printable ASCII, no line breaks",
    );
    headers['cache-control'] = options.cacheControl;
  }
  for (const [name, value] of Object.entries(options.metadata ?? {})) {
    assert(
      HEADER_TOKEN.test(name) && HEADER_VALUE.test(value),
      `put() on the s3 disk was given metadata that cannot travel as an x-amz-meta-* header (name ${describeValue(name)}, value ${describeValue(value)})`,
      'name each field with letters, digits and hyphens, and keep values printable ASCII — encodeURIComponent(value) anything else',
    );
    headers[`x-amz-meta-${name.toLowerCase()}`] = value;
  }
  if (options.retention !== undefined) {
    headers['x-amz-object-lock-mode'] = options.retention.mode;
    headers['x-amz-object-lock-retain-until-date'] = options.retention.retainUntil.toISOString();
  }
  if (options.legalHold !== undefined) {
    headers['x-amz-object-lock-legal-hold'] = options.legalHold ? 'ON' : 'OFF';
  }
  return headers;
}

/** The signed PUT. `undefined` on success; the provider's refusal otherwise, for the driver to code. */
export async function signedPut(
  wire: S3WireOptions,
  key: string,
  bytes: Uint8Array,
  options: PutOptions,
): Promise<S3Refusal | undefined> {
  const headers = putHeaders(bytes, options);
  const result = await sendSigned(wire, { method: 'PUT', key, headers, body: bytes });
  return result.ok ? undefined : result.refusal;
}

/**
 * "Nothing locks this", as the provider says it: no configuration on the object, or a bucket made
 * without Object Lock at all. Asked BEFORE the absent-object test, because the first answers 404.
 */
function isUnlockedAnswer(refusal: S3Refusal): boolean {
  if (refusal.code === 'NoSuchObjectLockConfiguration') return true;
  if (refusal.code === 'ObjectLockConfigurationNotFoundError') return true;
  return refusal.code === 'InvalidRequest' && /object lock/i.test(refusal.message);
}

export type LockRead =
  | { readonly kind: 'lock'; readonly lock: ObjectLock }
  | { readonly kind: 'refused'; readonly refusal: S3Refusal };

async function readSubresource(
  wire: S3WireOptions,
  key: string,
  subresource: 'retention' | 'legal-hold',
): Promise<{ readonly xml: string } | { readonly unlocked: true } | S3Refusal> {
  const result = await sendSigned(wire, { method: 'GET', key, subresource });
  if (result.ok) return { xml: await result.response.text() };
  return isUnlockedAnswer(result.refusal) ? { unlocked: true } : result.refusal;
}

const unreadable = (key: string, what: string): S3Refusal => ({
  name: 'S3Error',
  code: 'UnreadableAnswer',
  message: `the provider's ${what} for "${key}" did not parse`,
  statusCode: 200,
});

/**
 * Both halves of the lock, read in parallel. A refusal of either is the answer — a caller that
 * asked "may I delete this?" must not hear "nothing locks it" because one read was denied.
 */
export async function readObjectLock(wire: S3WireOptions, key: string): Promise<LockRead> {
  const [retention, hold] = await Promise.all([
    readSubresource(wire, key, 'retention'),
    readSubresource(wire, key, 'legal-hold'),
  ]);
  if ('code' in retention) return { kind: 'refused', refusal: retention };
  if ('code' in hold) return { kind: 'refused', refusal: hold };
  let lock: ObjectLock = { legalHold: false };
  if ('xml' in retention) {
    const mode = xmlField(retention.xml, 'Mode');
    const until = new Date(xmlField(retention.xml, 'RetainUntilDate') ?? '');
    if (!isRetentionMode(mode) || !Number.isFinite(until.getTime())) {
      return { kind: 'refused', refusal: unreadable(key, 'retention') };
    }
    lock = { retention: { mode, retainUntil: until }, legalHold: false };
  }
  if ('xml' in hold) {
    const status = xmlField(hold.xml, 'Status');
    if (status !== 'ON' && status !== 'OFF') {
      return { kind: 'refused', refusal: unreadable(key, 'legal hold') };
    }
    lock = { ...lock, legalHold: status === 'ON' };
  }
  return { kind: 'lock', lock };
}
