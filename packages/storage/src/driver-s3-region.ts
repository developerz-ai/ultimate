// Single responsibility: recognise the one provider refusal that names its own repair — a request
// signed for the wrong region — and turn it into the disk-misconfigured error it is. Split from
// driver-s3.ts because every call that sends a signed request asks this before its own verdict.

import { ConfigInvalidError, stringField } from '@ultimat3/core';

/** What S3 and every S3-compatible gateway answer a SigV4 scope with the wrong region in it. */
const REGION_MISMATCH_CODE = 'AuthorizationHeaderMalformed';

/**
 * `the region "auto" is wrong; expecting "us-east-1"` — double quotes from a gateway, single from
 * AWS. The captures are held to a region name's alphabet, so a sentence this process did not
 * write can put nothing else into a `fix:` line.
 */
const REGION_SENTENCE =
  /the region ['"]([A-Za-z0-9-]{1,64})['"] is wrong; expecting ['"]([A-Za-z0-9-]{1,64})['"]/;

/**
 * The refusal as `X_CONFIG_INVALID`, or `undefined` when `error` is anything else. A region
 * mismatch is the DISK misconfigured, exactly as a missing bucket is, so it carries that code from
 * every call rather than `X_STORAGE_LIST_FAILED` with a fix about `s3:ListBucket` from one and a
 * bare `S3Error` from another: `Bun.S3Client` signs for `auto` when no region is set, and a
 * provider that checks the scope refuses every request the app ever sends.
 *
 * A HEAD carries no body, so `exists()` and `stat()` never see this sentence — the first PUT,
 * LIST or DELETE does.
 */
export function regionMismatch(bucket: string, error: unknown): ConfigInvalidError | undefined {
  if (stringField(error, 'code') !== REGION_MISMATCH_CODE) return undefined;
  const match = REGION_SENTENCE.exec(stringField(error, 'message') ?? '');
  const sent = match?.[1];
  const expected = match?.[2];
  if (sent === undefined || expected === undefined) return undefined;
  return new ConfigInvalidError({
    cause: `the s3 disk for bucket "${bucket}" signed a request for region "${sent}" and its endpoint expects "${expected}"`,
    fix: `set S3_REGION=${expected} in .env (or pass region: '${expected}' to s3Driver), then re-run`,
    meta: { bucket, sent, expected },
  });
}
