// Single responsibility: the two server-side decisions a mounted `/_storage` route is made of —
// "may these bytes be written at that key?" and "may this actor read that key?". Transport-free
// on purpose: this package owns no `Request`, no `Response` and no status number (statuses are
// `@ultimat3/http`'s alone), so a route is a handler around these two calls and nothing else.
//
// Every step fails CLOSED and throws — a forged, expired, oversized, cross-tenant or
// wrong-typed request never reaches `disk.put`, and no path returns a "warning".

import type { Clock } from '@ultimat3/core';
import type { SignedUrlMethod, StorageDriver, StorageObject, StorageRead } from './driver';
import { orgMismatch, signedUrlExpired, signedUrlRejected, tooLarge } from './errors';
import { isTenantScoped, isWithinOrg } from './path';
import type { SignedUrlConstraints } from './signed-url';
import { signedUrlBaseFor, verifySignedUrl } from './signed-url';
import type { UploadPolicy } from './upload';
import { normalizeContentType, uploadPolicy, validateUpload } from './upload';

export interface SignedRequestInput {
  /** Absolute or route-relative — `verifySignedUrl` parses both. */
  readonly url: string;
  readonly secret: string;
  /**
   * Defaults to the base THIS disk signs under (`disk.signedUrlBase`), never to the bare mount
   * prefix: a second default here made every URL `localDriver` mints a signature-mismatch,
   * because the key parsed as `local/<key>`. Read off the driver rather than re-derived from
   * `disk.name`, which is the driver KIND — the segment is the registered disk name, and deriving
   * it twice is what let both halves agree with each other and disagree with the mounted route.
   * Pass one only for a route mounted somewhere else.
   */
  readonly baseUrl?: string | undefined;
  readonly disk: StorageDriver;
  /**
   * The ACTOR's org. Required, and checked against the key: a signed URL is a capability, and a
   * capability that leaks must still not read another tenant's object. Unreachable, not unguessable.
   */
  readonly orgId: string;
  readonly clock?: Clock | undefined;
}

export interface AcceptSignedUploadInput extends SignedRequestInput {
  readonly bytes: Uint8Array;
  /** The transport's `Content-Type`. Refused unless it equals the type the grant signed. */
  readonly declaredContentType?: string | undefined;
  /**
   * The transport's declared base64 SHA-256, travelling exactly as `declaredContentType` does: a
   * header the route reads and hands over, trusted for nothing — the bytes are hashed here and a
   * disagreement is refused. Without this field `uploadPolicy({ requireChecksum: true })` could
   * only ever fail, since nothing on this path could ever declare one.
   */
  readonly checksum?: string | undefined;
  readonly policy?: UploadPolicy | undefined;
}

/**
 * The signature check runs first and the expiry second — `verifySignedUrl` owns that order, and
 * the reason it exists is that a forged URL must never learn "the signature was fine, just late".
 * The org check runs on the verified key, so an attacker cannot probe org names with a fake one.
 */
async function constraintsFor(
  input: SignedRequestInput,
  method: SignedUrlMethod,
): Promise<SignedUrlConstraints> {
  const result = await verifySignedUrl({
    url: input.url,
    secret: input.secret,
    baseUrl: input.baseUrl ?? input.disk.signedUrlBase ?? signedUrlBaseFor(input.disk.name),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  if (!result.ok) {
    throw result.reason === 'expired'
      ? signedUrlExpired(input.url, result.detail)
      : signedUrlRejected(result.reason, result.detail);
  }
  const constraints = result.constraints;
  if (constraints.method !== method) {
    throw signedUrlRejected(
      'method-mismatch',
      `the URL is signed for ${constraints.method}, and this is a ${method}`,
    );
  }
  // The PAIR is the question "does this key belong to somebody else?". `isWithinOrg` alone
  // answered `false` for every un-scoped key, so an app's own `brand/logo.png` was unreachable
  // through a URL it had just signed — `path.ts` says so and `dev-storage.ts` already asks it this
  // way. An actor with no org is inside no org, so every tenant-scoped key is somebody else's;
  // checked here because `isWithinOrg` reads an empty org as a malformed key and would blame the
  // URL for the actor's missing claim.
  const orgId = input.orgId;
  if (isTenantScoped(constraints.key) && (orgId === '' || !isWithinOrg(constraints.key, orgId))) {
    throw orgMismatch(constraints.key, orgId);
  }
  return constraints;
}

/**
 * Take a presigned PUT and write it, or refuse. Four gates the client cannot move because all
 * four are inside the signature or inside the bytes: the signature itself, the expiry, the byte
 * count against the signed ceiling, and the declared type against both the signature and the
 * magic bytes. `validateUpload` runs last because it is the only one that reads the whole body.
 */
export async function acceptSignedUpload(input: AcceptSignedUploadInput): Promise<StorageObject> {
  const constraints = await constraintsFor(input, 'PUT');
  const key = constraints.key;

  // A PUT signed with no content type bounds nothing — any bytes, any type, at that key. The
  // grant always sets one, so this is a hand-rolled URL, and refusing is the only fail-closed
  // answer: the alternative is trusting whatever header the uploader sends.
  const signed = constraints.contentType;
  if (signed === undefined) {
    throw signedUrlRejected(
      'unconstrained',
      `"${key}" was signed with no content type, so nothing bounds what may be stored there`,
    );
  }
  const declaredHeader = input.declaredContentType;
  const declared = declaredHeader === undefined ? signed : normalizeContentType(declaredHeader);
  if (declared !== signed) {
    throw signedUrlRejected(
      'content-type-mismatch',
      `the request declares ${declared} and the signature covers ${signed}`,
    );
  }

  // The signed ceiling, checked before the policy's: the two can differ once a policy is edited
  // between the grant and the upload, and the narrower one is the one that was granted.
  const maxBytes = constraints.maxBytes;
  const size = input.bytes.byteLength;
  if (maxBytes !== undefined && size > maxBytes) throw tooLarge(key, size, maxBytes);

  const policy = input.policy ?? uploadPolicy();
  const validated = validateUpload(
    {
      key,
      declaredContentType: signed,
      bytes: input.bytes,
      ...(input.checksum === undefined ? {} : { checksum: input.checksum }),
    },
    policy,
  );
  return input.disk.put(validated.key, validated.bytes, {
    contentType: validated.contentType,
    checksum: validated.checksum,
  });
}

/**
 * The GET half. Same verification, same tenant boundary — a download URL that skipped either
 * would make every object readable by anyone who ever saw one link.
 */
export async function readSignedObject(input: SignedRequestInput): Promise<StorageRead> {
  const constraints = await constraintsFor(input, 'GET');
  return input.disk.get(constraints.key);
}
