// The X_* codes owned by @ultimat3/storage. Every `fix` is an exact edit or command: a
// rejected upload must tell the caller which constraint fired and where that constraint is
// configured, or the caller retries the same bytes forever.

import { registerErrorCodes, renderThrowable, UltimateError } from '@ultimat3/core';

/** Codes this package declares and owns. */
export const STORAGE_OWNED_ERROR_CODES = [
  'X_STORAGE_DISK_UNKNOWN',
  'X_STORAGE_NOT_FOUND',
  'X_STORAGE_PATH_UNSAFE',
  'X_STORAGE_TOO_LARGE',
  'X_STORAGE_TYPE_REJECTED',
  'X_STORAGE_CHECKSUM_MISMATCH',
  'X_STORAGE_URL_INVALID',
  'X_STORAGE_URL_EXPIRED',
  'X_STORAGE_URL_UNVERIFIABLE',
  'X_STORAGE_ORG_MISMATCH',
  'X_STORAGE_UPLOAD_FAILED',
  'X_STORAGE_DELETE_FAILED',
  'X_STORAGE_LIST_FAILED',
  'X_STORAGE_QUARANTINED',
] as const;

/**
 * `X_NOT_IMPLEMENTED` is `@ultimat3/core`'s. `storageNotImplemented()` throws it and this package
 * keeps no title for it — one code, one owner, one title, or the two copies drift apart in silence.
 * `X_IMAGE_UNSUPPORTED` / `X_IMAGE_DECODE_FAILED` are core's too and surface unwrapped (`image.ts`).
 * `X_ENV_MISSING` is core's for the same reason: an unset `STORAGE_SIGNING_SECRET` outside
 * development is a missing environment variable, not a storage concept needing its own code.
 */
export const STORAGE_BORROWED_ERROR_CODES = ['X_NOT_IMPLEMENTED', 'X_ENV_MISSING'] as const;

/** Every code storage can throw through `StorageError`: the owned ones plus the borrowed one. */
export const STORAGE_ERROR_CODES = [
  ...STORAGE_OWNED_ERROR_CODES,
  ...STORAGE_BORROWED_ERROR_CODES,
] as const;

export type StorageOwnedErrorCode = (typeof STORAGE_OWNED_ERROR_CODES)[number];
export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

export const STORAGE_ERROR_TITLES: Readonly<Record<StorageOwnedErrorCode, string>> = {
  X_STORAGE_DISK_UNKNOWN: 'no disk with that name is configured',
  X_STORAGE_NOT_FOUND: 'no object at that key',
  X_STORAGE_PATH_UNSAFE: 'object key escapes its prefix',
  X_STORAGE_TOO_LARGE: 'payload exceeds the upload size limit',
  X_STORAGE_TYPE_REJECTED: 'content type is not allowed for this upload',
  X_STORAGE_CHECKSUM_MISMATCH: 'bytes do not match the declared checksum',
  X_STORAGE_URL_INVALID: 'signed URL does not match its signature',
  X_STORAGE_URL_EXPIRED: 'signed URL is past its expiry',
  X_STORAGE_URL_UNVERIFIABLE: 'no way to verify a signed URL for this disk',
  X_STORAGE_ORG_MISMATCH: 'object key belongs to another org',
  X_STORAGE_UPLOAD_FAILED: 'the signed upload was refused',
  X_STORAGE_DELETE_FAILED: 'the object could not be deleted',
  X_STORAGE_LIST_FAILED: 'the objects could not be listed',
  X_STORAGE_QUARANTINED: 'the object is still in quarantine',
};

// One unconditional call, so a second package claiming one of storage's codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(
    Object.entries(STORAGE_ERROR_TITLES).map(([code, title]) => [code, { title }]),
  ),
);

export interface StorageErrorInit {
  readonly code: StorageErrorCode;
  readonly cause: string;
  readonly fix: string;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

export class StorageError extends UltimateError {
  override readonly name = 'StorageError';

  constructor(init: StorageErrorInit) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      meta: init.meta,
    });
  }
}

export function isStorageError(value: unknown): value is StorageError {
  return value instanceof StorageError;
}

export const diskUnknown = (name: string, configured: readonly string[]): StorageError =>
  new StorageError({
    code: 'X_STORAGE_DISK_UNKNOWN',
    cause: `no disk named "${name}" (configured: ${
      configured.length > 0 ? configured.join(', ') : 'none'
    })`,
    fix: `add "${name}" to storage.disks in app.config.ts, or call disk('${
      configured[0] ?? 'local'
    }')`,
    meta: { name, configured },
  });

/**
 * The `fix` is the shipped API call, not a CLI invocation: `x storage ls` is not in the command
 * registry, so following it lands on `X_CLI_UNKNOWN_COMMAND` — an instruction that costs the
 * reader a round-trip and teaches them a command that does not exist.
 */
export const objectNotFound = (disk: string, key: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_NOT_FOUND',
    cause: `disk "${disk}" has no object at "${key}"`,
    fix: `disk('${disk}').list({ prefix: '${key.split('/').slice(0, -1).join('/')}' })`,
    meta: { disk, key },
  });

export const pathUnsafe = (key: string, reason: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_PATH_UNSAFE',
    cause: `key ${JSON.stringify(key)} ${reason}`,
    fix: 'build the key with scopedKey(orgId, ...parts) — relative, forward slashes, no ".."',
    meta: { key, reason },
  });

export const tooLarge = (key: string, bytes: number, maxBytes: number): StorageError =>
  new StorageError({
    code: 'X_STORAGE_TOO_LARGE',
    cause: `"${key}" is ${bytes}B, over the policy limit of ${maxBytes}B`,
    fix: `raise maxBytes in the upload policy (uploadPolicy({ maxBytes: ${bytes} })), or compress the file first`,
    meta: { key, bytes, maxBytes },
  });

/**
 * The SERVER-side `put()` ceiling — a different fact from the policy limit `tooLarge` reports.
 * `put()` buffers, so a body past the ceiling is heap growth whose size the sender chooses: the
 * pod is OOM-killed and the caller sees a dropped connection instead of a refusal. Same CODE as
 * the policy limit, because it is the same answer to the same question (413, "too big"), and a
 * different `fix`, because raising `uploadPolicy` does not raise this one.
 *
 * `bytes` is what the disk had measured when it stopped, which for a stream is a floor rather
 * than the body's real length — the point of stopping is not reading the rest.
 */
export const putTooLarge = (
  disk: string,
  key: string,
  bytes: number,
  maxBytes: number,
): StorageError =>
  new StorageError({
    code: 'X_STORAGE_TOO_LARGE',
    cause: `"${key}" measured ${bytes}B against the ${disk} disk's put ceiling of ${maxBytes}B, and put() buffers the whole body`,
    fix:
      `send it direct with grantUpload({ disk, orgId, request }) instead of put(), or raise the ceiling: ` +
      (disk === 's3'
        ? `s3Driver({ bucket, maxPutBytes: ${bytes} })`
        : `localDriver({ root, maxPutBytes: ${bytes} })`),
    meta: { disk, key, bytes, maxBytes },
  });

/** The declared type is not on the allowlist at all. */
export const contentTypeNotAllowed = (
  key: string,
  declared: string,
  allowed: readonly string[],
): StorageError =>
  new StorageError({
    code: 'X_STORAGE_TYPE_REJECTED',
    cause: `"${key}" declares ${declared}, which is not in the policy allowlist (${allowed.join(', ')})`,
    fix: `add '${declared}' to allowedContentTypes in the upload policy, or upload one of: ${allowed.join(', ')}`,
    meta: { key, declared, allowed },
  });

/** The bytes say one thing and the client said another — the bytes win. */
export const contentTypeMismatch = (key: string, declared: string, sniffed: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_TYPE_REJECTED',
    cause: `"${key}" declares ${declared} but its magic bytes are ${sniffed}`,
    fix: `re-upload with Content-Type: ${sniffed}, or upload a genuine ${declared} file`,
    meta: { key, declared, sniffed },
  });

export const checksumMismatch = (key: string, declared: string, actual: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_CHECKSUM_MISMATCH',
    cause: `"${key}" declared sha256 ${declared} but the bytes hash to ${actual}`,
    fix: 'recompute the checksum over the exact bytes you send, or omit it and let the driver hash',
    meta: { key, declared, actual },
  });

/**
 * A signed request that does not match what was signed — a tampered constraint, a URL outside
 * the mounted base, a method the grant never covered, a header the signature contradicts.
 * ONE code for all of them on purpose: telling a forger which half of the tuple they got wrong
 * is an oracle, and `meta.reason` is there for the server's own log.
 */
export const signedUrlRejected = (reason: string, detail: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_URL_INVALID',
    cause: `the signed request was rejected as ${reason}: ${detail}`,
    fix: 'mint a fresh one with grantUpload({ disk, orgId, request }) and send it unedited — every constraint is inside the signature',
    meta: { reason, detail },
  });

export const signedUrlExpired = (key: string, detail: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_URL_EXPIRED',
    cause: `the signed request for "${key}" ${detail}`,
    fix: 'call grantUpload({ disk, orgId, request, expiresInMs }) again — a longer expiresInMs widens the window the signature grants',
    meta: { key, detail },
  });

/**
 * A delete the provider REFUSED — a denied `s3:DeleteObject`, a throttle, an expired credential,
 * a read-only mount. Deleting an absent key stays idempotent and never reaches here; everything
 * else does, because the alternative shipped for a year: `.catch(() => undefined)` turned 200
 * denied deletes into 200 successes, and an erasure sweep reported data gone that was still there.
 *
 * The `fix` is the driver's, not this factory's: the executable command that reproduces the
 * refusal with the provider's own words differs per disk, and a generic one is a round trip.
 */
export const deleteFailed = (
  disk: string,
  key: string,
  error: unknown,
  fix: string,
): StorageError => {
  const reason = renderThrowable(error);
  return new StorageError({
    code: 'X_STORAGE_DELETE_FAILED',
    cause: `disk "${disk}" refused DELETE "${key}": ${reason}`,
    fix,
    meta: { disk, key, reason },
  });
};

/**
 * A listing the disk REFUSED — a denied `s3:ListBucket`, a throttle, an expired credential, a root
 * this process cannot read. Exactly `deleteFailed`'s shape and for exactly its reason: an empty
 * page and an unreadable one are indistinguishable to a caller, and `sweepOrphans` walks `list()`,
 * so a swallowed refusal reports "no orphans" for a prefix nothing could see — the false-erasure
 * report the `delete()` fix already closed one call to the left.
 *
 * A root that does not exist yet is NOT this: a disk nobody has written to is honestly empty, and
 * both drivers answer it with an empty page.
 *
 * The `fix` is the driver's, for `deleteFailed`'s reason: the command that reproduces the refusal
 * with the disk's own words differs per driver, and a generic one costs a round trip.
 */
export const listFailed = (
  disk: string,
  prefix: string,
  error: unknown,
  fix: string,
): StorageError => {
  const reason = renderThrowable(error);
  return new StorageError({
    code: 'X_STORAGE_LIST_FAILED',
    cause: `disk "${disk}" refused to list "${prefix === '' ? '(the whole disk)' : prefix}": ${reason}`,
    fix,
    meta: { disk, prefix, reason },
  });
};

/**
 * A key still under the quarantine prefix. The framework never scans bytes — that is the app's
 * job — so the only thing it can enforce is that nothing leaves quarantine without the app
 * saying so, which is what `promoteAttachment` refusing this key means.
 */
export const quarantined = (key: string, orgId: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_QUARANTINED',
    cause: `"${key}" is still under the quarantine prefix, so nothing has cleared it for use`,
    fix: `scan the bytes, then releaseQuarantine({ disk, key: '${key}', orgId: '${orgId}' }) — promote the key it returns`,
    meta: { key, orgId },
  });

/** The key is well-formed and unforged, and still belongs to somebody else. */
export const orgMismatch = (key: string, orgId: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_ORG_MISMATCH',
    cause: `key "${key}" is not inside org "${orgId}"`,
    fix: `build it with scopedKey('${orgId}', ...parts), and pass the ACTOR's org as orgId — never one read off the request`,
    meta: { key, orgId },
  });

/** The client half: the disk answered the presigned PUT with something other than 2xx. */
export const uploadFailed = (path: string, status: number, detail: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_UPLOAD_FAILED',
    cause: `PUT ${path} answered ${status}: ${detail === '' ? 'no body' : detail}`,
    fix: 'call uploadFile({ file, grant }) again for a fresh grant; a 4xx here is the constraint named in the body, not a transport fault',
    meta: { path, status, detail },
  });

/**
 * The local disk fell back to the shipped dev signing key outside development.
 *
 * That literal is published in this repo, so anyone holding it can mint a signed `PUT` for any
 * key — including another org's — with `maxBytes` and `contentType` of their choosing, and
 * `acceptSignedUpload` trusts the signed constraints over the app's `uploadPolicy`. A 200KB
 * avatar grant becomes an unlimited upload of any type. Refused at construction, not at the
 * first `signedUrl()`: a process that cannot sign safely must not finish booting.
 */
/**
 * Neither half of the verification seam was available: no `secret:` in the call, and a disk that
 * cannot verify what it signed. Its own condition rather than a signature failure, because the two
 * need opposite edits — a mismatch is a forged or stale URL and this is a route that was never
 * handed a way to check one, and reporting it as `X_STORAGE_URL_INVALID` sent an operator looking
 * for an attacker.
 */
export const signedUrlUnverifiable = (diskName: string): StorageError =>
  new StorageError({
    code: 'X_STORAGE_URL_UNVERIFIABLE',
    cause: `the "${diskName}" disk was asked to verify a signed URL with no secret in the call, and its driver implements no verifySigned()`,
    fix: 'pass secret: to the call, or use a driver that signs its own URLs (localDriver) — a provider-signed disk (s3) verifies at the provider and never reaches this path',
    meta: { disk: diskName },
  });

export const signingSecretMissing = (environment: string): StorageError =>
  new StorageError({
    code: 'X_ENV_MISSING',
    // The environment names what `resolveEnvironment()` resolved, which may have come from
    // NODE_ENV — naming ULTIMATE_ENV here reported a variable the process never set.
    cause: `the local disk has no usable signing secret (no signingSecret option, and STORAGE_SIGNING_SECRET is unset, empty or the published development key) and the resolved environment is "${environment}", so it would sign URLs with the shipped development key`,
    fix: 'export STORAGE_SIGNING_SECRET="$(openssl rand -hex 32)"',
    meta: { key: 'STORAGE_SIGNING_SECRET', environment },
  });

/** An interface-complete driver whose remote half is not bound yet. Always carries a fix. */
export const storageNotImplemented = (feature: string, fix: string): StorageError =>
  new StorageError({
    code: 'X_NOT_IMPLEMENTED',
    cause: `${feature} is declared but not implemented in @ultimat3/storage`,
    fix,
    meta: { feature },
  });
