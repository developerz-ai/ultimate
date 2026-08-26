// Single responsibility: minting ONE presigned PUT for ONE file, with the tenant prefix and the
// policy already inside the signature. The client never names the key — it asks for a grant and
// is told one — so a caller cannot aim an upload at another org's prefix, at an attached row it
// does not own, or at a size the policy never allowed. Everything this returns is derived; the
// only client input that survives is the filename's extension, and only if it survives a regex.

import type { Clock } from '@ultimat3/core';
import { finiteCount, systemClock } from '@ultimat3/core';
import type { AttachmentTarget } from './attachment';
import { attachmentKey, pendingKey, quarantineKey, uploadName } from './attachment';
import type { StorageDriver } from './driver';
import { contentTypeNotAllowed, tooLarge } from './errors';
import { DEFAULT_SIGNED_URL_TTL_MS } from './signed-url';
import type { UploadPolicy } from './upload';
import { normalizeContentType, uploadPolicy } from './upload';

export interface UploadRequest {
  /** The client's own name for the file. Used for its extension and nothing else. */
  readonly filename: string;
  readonly contentType: string;
  /**
   * Optional, and never trusted: it only buys the client an early refusal. The bytes are counted
   * again by `acceptSignedUpload`, which is the authority, so a lie here changes nothing.
   */
  readonly size?: number | undefined;
}

export interface UploadGrant {
  /** Where the bytes will live. The app stores this on the row, never the URL. */
  readonly key: string;
  readonly url: string;
  readonly method: 'PUT';
  /** Normalised. The client MUST send exactly this as `Content-Type` or the accept refuses. */
  readonly contentType: string;
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
  /** Absent means the row does not exist yet, so the key lands under `pending/`. */
  readonly target?: AttachmentTarget | undefined;
  /**
   * Land the bytes under `pending/quarantine/` instead, so nothing can promote them until the
   * app's scan job calls `releaseQuarantine`. Only meaningful without a `target`: an upload
   * aimed straight at a row has no promotion step left to gate.
   */
  readonly quarantine?: boolean | undefined;
  readonly expiresInMs?: number | undefined;
  readonly clock?: Clock | undefined;
  /** Determinism seam for tests. Defaults to `crypto.randomUUID()`. */
  readonly uploadId?: (() => string) | undefined;
}

/**
 * Refuses before it signs. A URL only exists for a request the policy already accepted, so an
 * over-limit or disallowed upload costs one round trip instead of a full transfer — and the
 * signature then carries the same two constraints, so the client cannot widen either of them.
 */
export async function grantUpload(input: GrantUploadInput): Promise<UploadGrant> {
  const policy = input.policy ?? uploadPolicy();
  const clock = input.clock ?? systemClock;
  const declared = normalizeContentType(input.request.contentType);
  const name = uploadName(
    (input.uploadId ?? (() => crypto.randomUUID()))(),
    input.request.filename,
  );
  const pending =
    input.quarantine === true ? quarantineKey(input.orgId, name) : pendingKey(input.orgId, name);
  const key = input.target === undefined ? pending : attachmentKey(input.orgId, input.target, name);

  if (!policy.allowedContentTypes.includes(declared)) {
    throw contentTypeNotAllowed(key, declared, policy.allowedContentTypes);
  }
  const size = input.request.size;
  if (size !== undefined && Number.isSafeInteger(size) && size > policy.maxBytes) {
    throw tooLarge(key, size, policy.maxBytes);
  }

  // Refused here as well as in the presigner one call down: `expiresAt: now + NaN` is `NaN` in the
  // grant this function RETURNS, and the message a caller can act on names `createUploadGrant`'s
  // own option rather than `buildSignedUrl`'s.
  const expiresInMs = finiteCount(
    'createUploadGrant',
    'expiresInMs',
    input.expiresInMs ?? DEFAULT_SIGNED_URL_TTL_MS,
    1,
  );
  const url = await input.disk.signedUrl(key, {
    method: 'PUT',
    maxBytes: policy.maxBytes,
    contentType: declared,
    expiresInMs,
  });
  return {
    key,
    url,
    method: 'PUT',
    contentType: declared,
    maxBytes: policy.maxBytes,
    expiresAt: clock.now().getTime() + expiresInMs,
  };
}
