// Single responsibility: the s3 disk's `MultipartCapability` — the browser's parts go straight to
// the bucket on URLs core's signer presigns, and every other step is one signed call. No bytes
// pass through this process, so the web role never carries them.

import type { StorageDriver, StorageObject } from './driver';
import {
  abortS3Upload,
  completeS3Upload,
  createS3Upload,
  listS3Parts,
  listS3Uploads,
} from './driver-s3-multipart';
import type { S3Refusal, S3WireOptions } from './driver-s3-signed';
import { objectNotFound } from './errors';
import { partsInvalid, uploadUnknown } from './errors-multipart';
import type { MultipartCapability } from './multipart';
import { assertSafeKey } from './path';

export interface S3MultipartInput {
  readonly wire: S3WireOptions;
  /** The disk: it presigns the part URLs and stats the completed object. */
  readonly driver: StorageDriver;
  /** The disk's coded write refusal for a key. */
  readonly refusedWrite: (key: string) => (refusal: unknown) => never;
}

/** S3's answer for an id that is not an open upload: never opened, completed or aborted. */
const isUnknownUpload = (refusal: S3Refusal): boolean => refusal.code === 'NoSuchUpload';
/** S3's refusals of a Complete whose parts do not match what it holds. */
const PART_REFUSALS: ReadonlySet<string> = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
]);

export function s3Multipart(input: S3MultipartInput): MultipartCapability {
  const { wire, driver } = input;
  const target = (key: string, uploadId?: string) => ({
    wire,
    key,
    refused: (refusal: S3Refusal): never => {
      if (uploadId !== undefined && isUnknownUpload(refusal)) {
        throw uploadUnknown(driver.name, key, uploadId);
      }
      if (uploadId !== undefined && PART_REFUSALS.has(refusal.code)) {
        throw partsInvalid(key, uploadId, refusal.message);
      }
      return input.refusedWrite(key)(refusal);
    },
  });

  return {
    create: (key, { contentType }) =>
      createS3Upload(target(assertSafeKey(key)), { 'content-type': contentType }),

    signPart: (key, uploadId, partNumber, { contentLength, expiresInMs }) =>
      driver.signedUrl(key, {
        method: 'PUT',
        contentLength,
        expiresInMs,
        part: { uploadId, partNumber },
      }),

    listParts: (key, uploadId) => listS3Parts(target(assertSafeKey(key), uploadId), uploadId),

    async complete(key, uploadId, parts): Promise<StorageObject> {
      const safe = assertSafeKey(key);
      await completeS3Upload(target(safe, uploadId), uploadId, parts);
      const object = await driver.stat(safe);
      if (object === undefined) throw objectNotFound(driver.name, safe);
      return object;
    },

    async abort(key, uploadId): Promise<void> {
      const safe = assertSafeKey(key);
      const refusal = await abortS3Upload(target(safe), uploadId);
      // Gone already is the state asked for; anything else is a refusal the caller must hear.
      if (refusal !== undefined && !isUnknownUpload(refusal)) input.refusedWrite(safe)(refusal);
    },

    listUploads: (prefix) =>
      listS3Uploads(
        { wire, refused: (refusal) => input.refusedWrite(prefix ?? '')(refusal) },
        prefix,
      ),
  };
}
