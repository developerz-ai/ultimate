// Single responsibility: the s3 copy that names a revision. `Bun.S3Client`'s `write` takes no
// condition, and `x-amz-copy-source-if-match` is what lets the provider refuse an overwrite in the
// one moment this process cannot see, so a revision-bound copy is a signed CopyObject.

import { type S3Refusal, type S3WireOptions, sendSigned, xmlField } from './driver-s3-signed';

/**
 * The provider's refusal, or `undefined` when the copy landed. A 200 is not yet a verdict: S3 sends
 * its headers before a long copy ends, so a failure can arrive as an `<Error>` inside a 200's body.
 */
export async function signedCopy(
  options: S3WireOptions,
  source: string,
  destination: string,
  ifMatch: string,
): Promise<S3Refusal | undefined> {
  const path = source.split('/').map(encodeURIComponent).join('/');
  const result = await sendSigned(options, {
    method: 'PUT',
    key: destination,
    headers: {
      'x-amz-copy-source': `/${encodeURIComponent(options.bucket)}/${path}`,
      'x-amz-copy-source-if-match': ifMatch,
    },
  });
  if (!result.ok) return result.refusal;
  const body = await result.response.text();
  if (!body.includes('<Error>')) return undefined;
  return {
    name: 'S3Error',
    code: xmlField(body, 'Code') ?? 'InternalError',
    message: xmlField(body, 'Message') ?? 'the copy failed after it was accepted',
    statusCode: 500,
  };
}
