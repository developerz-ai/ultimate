// Single responsibility: the server half of an upload in parts — open a session under
// `grantUpload`'s policy gate, sign a part, list what landed, complete, abort. Each is a function the
// app wraps in its own `action()`, and each is held to the ACTOR's tenant, so an upload id read off a
// request reaches nothing outside the caller's org.

import { assert } from '@ultimat3/core';
import type { StorageDriver, StorageObject } from './driver';
import { orgMismatch, tooLarge } from './errors';
import { multipartUnsupported, partsInvalid } from './errors-multipart';
import { decideGrant, type GrantUploadInput } from './grant';
import {
  type CompletedPart,
  MAX_PART_BYTES,
  MAX_PARTS,
  MIN_PART_BYTES,
  type MultipartCapability,
  matchParts,
  partBytesFor,
  type UploadedPart,
} from './multipart';
import { isWithinOrg } from './path';
import { DEFAULT_SIGNED_URL_TTL_MS } from './signed-url';
import type { UploadPolicy } from './upload';

export interface GrantMultipartInput extends GrantUploadInput {
  /** A part size the app prefers; raised to what 10,000 parts need, never below S3's 5 MiB. */
  readonly partBytes?: number | undefined;
}

export interface MultipartGrant {
  readonly key: string;
  readonly uploadId: string;
  /** Every part but the last is exactly this long. */
  readonly partBytes: number;
  /** How many parts the declared size takes at `partBytes`. */
  readonly maxParts: number;
  /** Normalised: the type the object is created under. */
  readonly contentType: string;
  /** The declared size, already held to the policy. */
  readonly size: number;
  /** Epoch ms: the part URLs' window from now. Each `signPart` opens a fresh one. */
  readonly expiresAt: number;
}

/** What names one open session. `orgId` is the actor's, resolved server-side. */
export interface UploadSessionInput {
  readonly disk: StorageDriver;
  readonly orgId: string;
  readonly key: string;
  readonly uploadId: string;
}

export interface SignPartInput extends UploadSessionInput {
  readonly partNumber: number;
  /** This part's exact size: `partBytes`, or less for the last part. Signed. */
  readonly size: number;
  readonly expiresInMs?: number | undefined;
}

export interface CompleteUploadInput extends UploadSessionInput {
  /** Ascending. Etags are optional: the disk's own, read by `listParts` here, are what is sent. */
  readonly parts: readonly CompletedPart[];
  /** The policy the grant was made under: a completed object past its `maxBytes` is refused. */
  readonly policy?: UploadPolicy | undefined;
}

const capabilityOf = (disk: StorageDriver, key: string): MultipartCapability => {
  if (disk.multipart === undefined) throw multipartUnsupported(disk.name, key);
  return disk.multipart;
};

/** The key a session was opened for, held to the actor's org exactly as `accept.ts` holds a URL. */
const sessionOf = (input: UploadSessionInput): MultipartCapability => {
  // Every session a grant opens is under `org/<id>/`, so a key outside the actor's org is refused
  // whether or not another tenant owns it: no shared prefix takes parts.
  if (!isWithinOrg(input.key, input.orgId)) {
    throw orgMismatch(input.key, input.orgId);
  }
  return capabilityOf(input.disk, input.key);
};

/** The part size: the app's preference, raised to what the size and the protocol require. */
const partSizeFor = (size: number, preferred: number | undefined): number => {
  const floor = partBytesFor(size);
  if (preferred === undefined) return floor;
  assert(
    Number.isSafeInteger(preferred) && preferred >= MIN_PART_BYTES && preferred <= MAX_PART_BYTES,
    `grantMultipart was handed partBytes ${String(preferred)}, outside S3's ${MIN_PART_BYTES}..${MAX_PART_BYTES} bytes`,
    `grantMultipart({ disk, orgId, request, partBytes: ${MIN_PART_BYTES} })   # or omit it`,
  );
  return Math.max(floor, preferred);
};

/** Refuses as `grantUpload` refuses, then opens the session the parts go into. */
export async function grantMultipart(input: GrantMultipartInput): Promise<MultipartGrant> {
  const granted = decideGrant('grantMultipart', input);
  const multipart = capabilityOf(input.disk, granted.key);
  const partBytes = partSizeFor(granted.size, input.partBytes);
  const uploadId = await multipart.create(granted.key, { contentType: granted.contentType });
  return {
    key: granted.key,
    uploadId,
    partBytes,
    maxParts: Math.ceil(granted.size / partBytes),
    contentType: granted.contentType,
    size: granted.size,
    expiresAt: granted.now + granted.expiresInMs,
  };
}

/** One part's URL, its length inside the signature. */
export async function signPart(input: SignPartInput): Promise<string> {
  const multipart = sessionOf(input);
  const { partNumber, size } = input;
  assert(
    Number.isSafeInteger(partNumber) && partNumber >= 1 && partNumber <= MAX_PARTS,
    `signPart was handed partNumber ${String(partNumber)}, outside 1..${MAX_PARTS}`,
    'signPart({ disk, orgId, key, uploadId, partNumber: 1, size })',
  );
  assert(
    Number.isSafeInteger(size) && size >= 1 && size <= MAX_PART_BYTES,
    `signPart was handed size ${String(size)}, not a part of 1..${MAX_PART_BYTES} bytes`,
    'signPart({ disk, orgId, key, uploadId, partNumber, size: grant.partBytes })',
  );
  return multipart.signPart(input.key, input.uploadId, partNumber, {
    contentLength: size,
    expiresInMs: input.expiresInMs === undefined ? DEFAULT_SIGNED_URL_TTL_MS : input.expiresInMs,
  });
}

/** What landed, ascending — the resume: a client sends only the parts not here. */
export function listParts(input: UploadSessionInput): Promise<readonly UploadedPart[]> {
  return sessionOf(input).listParts(input.key, input.uploadId);
}

/**
 * The parts named, checked against what the disk holds, then assembled. The etags sent are the
 * disk's own, so the browser never needs a bucket's CORS to expose `ETag`. A total past the policy
 * aborts the session: those bytes were never going to be promoted.
 */
export async function completeUpload(input: CompleteUploadInput): Promise<StorageObject> {
  const multipart = sessionOf(input);
  const stored = await multipart.listParts(input.key, input.uploadId);
  const matched = matchParts(input.parts, stored);
  if ('problem' in matched) throw partsInvalid(input.key, input.uploadId, matched.problem);
  const total = matched.parts.reduce((sum, part) => sum + part.size, 0);
  const maxBytes = input.policy?.maxBytes;
  if (maxBytes !== undefined && total > maxBytes) {
    await multipart.abort(input.key, input.uploadId);
    throw tooLarge(input.key, total, maxBytes);
  }
  return multipart.complete(input.key, input.uploadId, matched.parts);
}

/** Drops the session and every part. An id already gone is the state asked for. */
export function abortUpload(input: UploadSessionInput): Promise<void> {
  return sessionOf(input).abort(input.key, input.uploadId);
}
