// Single responsibility: minting ONE presigned PUT for ONE file, with the tenant prefix and the
// policy already inside the signature. The client never names the key — it asks for a grant and
// is told one — so a caller cannot aim an upload at another org's prefix, at an attached row it
// does not own, or at a size the policy never allowed. Everything this returns is derived; the
// only client input that survives is the filename's extension, and only if it survives a regex.

import type { Clock } from '@ultimat3/core';
import { finiteCount, systemClock } from '@ultimat3/core';
import type { AttachmentTarget } from './attachment';
import { attachmentKey, pendingKey, uploadName } from './attachment';
import type { StorageDriver } from './driver';
import { contentTypeNotAllowed, tooLarge } from './errors';
import { targetUnscanned } from './errors-scan';
import { uploadSizeUndeclared } from './errors-stream';
import { DEFAULT_SIGNED_URL_TTL_MS } from './signed-url';
import type { UploadPolicy } from './upload';
import { normalizeContentType, uploadPolicy } from './upload';
import { uploadScanner } from './upload-scanner';

export interface UploadRequest {
  /** The client's own name for the file. Used for its extension and nothing else. */
  readonly filename: string;
  readonly contentType: string;
  /**
   * The file's size in bytes. Required, because it is what the URL binds: an s3 disk signs it as the
   * exact `Content-Length`, and the local disks sign it as the ceiling `acceptSignedUpload` counts
   * against. A lie here shrinks the client's own upload; it cannot pass the policy's `maxBytes`.
   */
  readonly size: number;
}

export interface UploadGrant {
  /** Where the bytes will live. The app stores this on the row, never the URL. */
  readonly key: string;
  readonly url: string;
  readonly method: 'PUT';
  /** Normalised. The client MUST send exactly this as `Content-Type` or the accept refuses. */
  readonly contentType: string;
  /** What the URL accepts: the declared `size`, already held to the policy. */
  readonly maxBytes: number;
  /** Epoch ms. The grant's own view of the window; the signature is what actually enforces it. */
  readonly expiresAt: number;
}

export interface GrantUploadInput {
  readonly disk: StorageDriver;
  /** The ACTOR's org, resolved server-side. A value read off the request is a tenant bypass. */
  readonly orgId: string;
  readonly request: UploadRequest;
  readonly policy?: UploadPolicy | undefined;
  /**
   * Absent means the row does not exist yet, so the key lands under `pending/`. Refused while an
   * `uploadScanner` is installed (`X_STORAGE_TARGET_UNSCANNED`): a targeted key skips
   * `promoteAttachment`, the one place a scan runs.
   */
  readonly target?: AttachmentTarget | undefined;
  readonly expiresInMs?: number | undefined;
  readonly clock?: Clock | undefined;
  /** Determinism seam for tests. Defaults to `crypto.randomUUID()`. */
  readonly uploadId?: (() => string) | undefined;
}

/** What every grant decides before it signs: the key, the type and size the policy accepted. */
export interface GrantedUpload {
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
  readonly expiresInMs: number;
  readonly now: number;
}

/**
 * The refusals both grants share — `grantUpload`'s one PUT and `grantMultipart`'s parts — so a
 * request one refuses the other refuses too: the key derived, never the client's; the type held to
 * the allowlist; the size to the policy; the window screened.
 */
export function decideGrant(caller: string, input: GrantUploadInput): GrantedUpload {
  const policy = input.policy ?? uploadPolicy();
  const clock = input.clock ?? systemClock;
  const declared = normalizeContentType(input.request.contentType);
  const name = uploadName(
    (input.uploadId ?? (() => crypto.randomUUID()))(),
    input.request.filename,
  );
  const key =
    input.target === undefined
      ? pendingKey(input.orgId, name)
      : attachmentKey(input.orgId, input.target, name);
  const scanner = uploadScanner();
  if (input.target !== undefined && scanner !== undefined) {
    throw targetUnscanned(caller, key, scanner.name);
  }

  if (!policy.allowedContentTypes.includes(declared)) {
    throw contentTypeNotAllowed(key, declared, policy.allowedContentTypes);
  }
  const size = input.request.size;
  // Off the wire, so the type promises nothing here. An empty file has nothing to upload.
  if (!Number.isSafeInteger(size) || size < 1) throw uploadSizeUndeclared(key, size);
  if (size > policy.maxBytes) throw tooLarge(key, size, policy.maxBytes);

  // Refused here as well as in the presigner one call down: `expiresAt: now + NaN` is `NaN` in the
  // grant this function RETURNS, and the message a caller can act on names the grant's own option
  // rather than `buildSignedUrl`'s. `=== undefined`, never `??`, for the reason `buildSignedUrl`
  // states: `??` coalesces on `null` too, so an explicit one took the default instead.
  const expiresInMs = finiteCount(
    caller,
    'expiresInMs',
    input.expiresInMs === undefined ? DEFAULT_SIGNED_URL_TTL_MS : input.expiresInMs,
    1,
  );
  return { key, contentType: declared, size, expiresInMs, now: clock.now().getTime() };
}

/**
 * Refuses before it signs. A URL only exists for a request the policy already accepted, so an
 * over-limit or disallowed upload costs one round trip instead of a full transfer. The signature
 * then carries the size on every disk, so the client cannot widen it: at the provider's PUT on s3
 * (403 on any other length), and at `acceptSignedUpload` on the local disks. The content type is
 * signed only on a disk that signs its own URLs; on s3, `promoteAttachment` sniffs it.
 */
export async function grantUpload(input: GrantUploadInput): Promise<UploadGrant> {
  const { key, contentType, size, expiresInMs, now } = decideGrant('grantUpload', input);
  const url = await input.disk.signedUrl(key, {
    method: 'PUT',
    maxBytes: size,
    contentLength: size,
    contentType,
    expiresInMs,
  });
  return { key, url, method: 'PUT', contentType, maxBytes: size, expiresAt: now + expiresInMs };
}
