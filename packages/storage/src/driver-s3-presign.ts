// Single responsibility: the s3 disk's `signedUrl`, both presigners under one rule. Bun's presign
// binds method and expiry and signs `host` alone: `type` becomes `response-content-type`, which
// governs a GET, so a PUT's `Content-Type` is unsigned and `promoteAttachment` sniffs the object. A
// `contentLength` leaves Bun for core's signer, the one way a presign can hold a size.

import { assert, finiteCount, MAX_AWS_PRESIGN_SECONDS } from '@ultimat3/core';
import { type SignedUrlOptions, signedByteBound } from './driver';
import type { S3FileLike } from './driver-s3-client';
import { presignBoundPut, type S3WireOptions } from './driver-s3-signed';
import { uploadSizeUndeclared } from './errors-stream';
import { assertSafeKey } from './path';
import { DEFAULT_SIGNED_URL_TTL_MS } from './signed-url';

export async function s3SignedUrl(
  wire: S3WireOptions,
  fileOf: (key: string) => S3FileLike,
  key: string,
  urlOptions: SignedUrlOptions | undefined,
): Promise<string> {
  // Screened with the SAME function `buildSignedUrl` applies on the local disk: `Math.ceil(NaN /
  // 1000)` is `NaN`, so `X-Amz-Expires=NaN` went to AWS and the app got a 403 on a link it believed
  // it had just minted. `=== undefined` rather than `??`, so an explicit `null` is refused.
  const expiresInMs = finiteCount(
    'the s3 driver',
    'expiresInMs',
    urlOptions?.expiresInMs === undefined ? DEFAULT_SIGNED_URL_TTL_MS : urlOptions.expiresInMs,
    1,
  );
  const seconds = Math.ceil(expiresInMs / 1000);
  // Before the branch, so Bun's presign cannot mint a URL past SigV4's limit the other refuses.
  assert(
    seconds <= MAX_AWS_PRESIGN_SECONDS,
    `signedUrl() on the s3 disk was given expiresInMs ${expiresInMs}, past SigV4's seven days`,
    `signedUrl(key, { expiresInMs: ${MAX_AWS_PRESIGN_SECONDS * 1000} })   # the longest a presign lives`,
  );
  const safe = assertSafeKey(key);
  const contentLength = signedByteBound('s3', urlOptions);
  if (urlOptions?.contentLength !== undefined && contentLength !== undefined) {
    return presignBoundPut(wire, safe, contentLength, seconds, urlOptions?.part);
  }
  // A part names its exact size or nothing: Bun's presign below would drop it and sign a whole PUT.
  if (urlOptions?.part !== undefined) throw uploadSizeUndeclared(safe, undefined);
  // A ceiling bounds a PUT; a read has no body, and the local disks ignore it there too.
  if (urlOptions?.method === 'PUT' && urlOptions.maxBytes !== undefined) {
    throw uploadSizeUndeclared(safe, undefined);
  }
  return fileOf(safe).presign({
    method: urlOptions?.method ?? 'GET',
    expiresIn: seconds,
    ...(urlOptions?.contentType === undefined ? {} : { type: urlOptions.contentType }),
  });
}
