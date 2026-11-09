// Single responsibility: the s3 copy — ONE signed CopyObject, directive COPY, so the provider
// carries the source's type, `Cache-Control` and `x-amz-meta-*` as local and memory do (Bun's
// `write(S3File)` dropped both); `ifMatch` sends `x-amz-copy-source-if-match`. Past 5 GiB, CopyObject
// refuses: `driver-s3-copy-parts.ts`.

import { type S3Refusal, type S3WireOptions, sendSigned, xmlField } from './driver-s3-signed';

/** CopyObject's own ceiling: S3 refuses a larger source with `InvalidRequest`. */
export const MAX_COPY_OBJECT_BYTES = 5 * 1024 ** 3;

/** `/<bucket>/<key>`, each segment escaped — the `x-amz-copy-source` CopyObject and UploadPartCopy name. */
export const copySourceOf = (options: S3WireOptions, source: string): string =>
  `/${encodeURIComponent(options.bucket)}/${source.split('/').map(encodeURIComponent).join('/')}`;

/**
 * The provider's refusal, or `undefined` when the copy landed. A 200 is not yet a verdict: S3 sends
 * its headers before a long copy ends, so a failure can arrive as an `<Error>` inside a 200's body.
 */
export async function signedCopy(
  options: S3WireOptions,
  source: string,
  destination: string,
  ifMatch?: string | undefined,
): Promise<S3Refusal | undefined> {
  const result = await sendSigned(options, {
    method: 'PUT',
    key: destination,
    headers: {
      'x-amz-copy-source': copySourceOf(options, source),
      ...(ifMatch === undefined ? {} : { 'x-amz-copy-source-if-match': ifMatch }),
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
