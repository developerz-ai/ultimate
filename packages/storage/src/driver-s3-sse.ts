// Single responsibility: the one `put()` option the s3 disk cannot honour, refused by name with the
// bucket-wide command that does the job instead.

import { NotImplementedError, renderFixLiteral, renderFixShellArg } from '@ultimat3/core';
import type { PutOptions } from './driver';

/**
 * Everything `put()` may be handed that this driver cannot honour, refused before a byte moves.
 * A typed refusal at the call site is the whole point: `serverSideEncryption` exists on
 * `PutOptions` so that "this disk cannot prove per-object encryption" is something an engineer
 * meets while writing the call, not while answering a security review.
 */
export function refuseUnsupportedPut(bucket: string, putOptions?: PutOptions): void {
  const sse = putOptions?.serverSideEncryption;
  if (sse === undefined) return;
  // The key id is the caller's own option, spliced into single-quoted JSON: `renderFixLiteral`
  // escapes the `"` and `\` JSON needs, and a `'` — the one byte live inside single quotes — makes
  // it the placeholder rather than ending the argument (plan 101 row S12).
  const keyId = sse.kmsKeyId?.includes("'") === false ? sse.kmsKeyId : undefined;
  const bucketArg = renderFixShellArg(bucket, "'<bucket>'");
  throw new NotImplementedError({
    cause:
      'per-object server-side encryption on the s3 driver (Bun.S3Client exposes acl, storageClass and type, and nothing for x-amz-server-side-encryption) is not implemented by this driver — set it bucket-wide with the command in fix, then drop serverSideEncryption from put()',
    fix:
      sse.algorithm === 'aws:kms'
        ? `aws s3api put-bucket-encryption --bucket ${bucketArg} --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":${renderFixLiteral(keyId, '"<key-arn>"')}},"BucketKeyEnabled":true}]}'`
        : `aws s3api put-bucket-encryption --bucket ${bucketArg} --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'`,
  });
}
