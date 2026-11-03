// Single responsibility: the four S3 multipart calls over the disk's signed requests. Each answers
// what its caller goes on with, or hands the provider's refusal to the disk's coded `refused`. The
// order they run in, and what a failure aborts, is the caller's.

import { type S3Refusal, type S3WireOptions, sendSigned, xmlField } from './driver-s3-signed';

export interface S3UploadTarget {
  readonly wire: S3WireOptions;
  readonly key: string;
  /** The disk's coded write refusal. A refusal is never thrown bare. */
  readonly refused: (refusal: S3Refusal) => never;
}

const unreadable = (what: string): S3Refusal => ({
  name: 'S3Error',
  code: 'UnreadableAnswer',
  message: `the provider's answer to ${what} carried nothing to go on`,
  statusCode: 200,
});

const completeXml = (etags: readonly string[]): Uint8Array =>
  new TextEncoder().encode(
    `<CompleteMultipartUpload>${etags
      .map((etag, at) => `<Part><PartNumber>${at + 1}</PartNumber><ETag>${etag}</ETag></Part>`)
      .join('')}</CompleteMultipartUpload>`,
  );

/** CreateMultipartUpload. The object's own headers travel here: a part has none. */
export async function createS3Upload(
  { wire, key, refused }: S3UploadTarget,
  headers: Readonly<Record<string, string>>,
): Promise<string> {
  const result = await sendSigned(wire, { method: 'POST', key, headers, query: { uploads: '' } });
  if (!result.ok) return refused(result.refusal);
  const id = xmlField(await result.response.text(), 'UploadId');
  return id === undefined ? refused(unreadable('CreateMultipartUpload')) : id;
}

/** UploadPart, answering the etag the Complete must name. */
export async function uploadS3Part(
  { wire, key, refused }: S3UploadTarget,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
): Promise<string> {
  const result = await sendSigned(wire, {
    method: 'PUT',
    key,
    query: { partNumber: String(partNumber), uploadId },
    body,
  });
  if (!result.ok) return refused(result.refusal);
  await result.response.body?.cancel().catch(() => undefined);
  const etag = result.response.headers.get('etag');
  return etag === null ? refused(unreadable('UploadPart')) : etag;
}

/** CompleteMultipartUpload, `etags` in part order. The object exists only once this returns. */
export async function completeS3Upload(
  { wire, key, refused }: S3UploadTarget,
  uploadId: string,
  etags: readonly string[],
): Promise<void> {
  const result = await sendSigned(wire, {
    method: 'POST',
    key,
    query: { uploadId },
    body: completeXml(etags),
  });
  if (!result.ok) return refused(result.refusal);
  // S3 answers a failed Complete with 200 and an `<Error>` body, once it has started working.
  const answer = await result.response.text();
  if (answer.includes('<Error>')) {
    refused({
      name: 'S3Error',
      code: xmlField(answer, 'Code') ?? 'CompleteFailed',
      message: xmlField(answer, 'Message') ?? 'the provider refused the Complete',
      statusCode: 200,
    });
  }
}

/** AbortMultipartUpload. `undefined` on success; the refusal otherwise, for the caller to weigh. */
export async function abortS3Upload(
  { wire, key }: S3UploadTarget,
  uploadId: string,
): Promise<S3Refusal | undefined> {
  const result = await sendSigned(wire, { method: 'DELETE', key, query: { uploadId } });
  return result.ok ? undefined : result.refusal;
}
