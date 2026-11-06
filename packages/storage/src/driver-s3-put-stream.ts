// Single responsibility: `putStream` on the s3 wire — the pump that cuts a body into parts. Not
// `S3File.writer()`, measured on Bun 1.4.4: `end(error)` COMPLETES the upload, so an overrun would
// replace the object at the key, and the writer cannot send `x-amz-meta-*`. Here the object does not
// exist until the Complete, and every other exit aborts.

import { pumpBounded } from './byte-pump';
import type { PutOptions } from './driver';
import { objectHeaders, signedPut } from './driver-s3-lock';
import {
  abortS3Upload,
  completeS3Upload,
  createS3Upload,
  type S3UploadTarget,
  uploadS3Part,
} from './driver-s3-multipart';
import {
  isAnswered,
  multipartEtagOf,
  type S3Stat,
  sentObject,
  settleComplete,
  settleLostPut,
} from './driver-s3-settle';
import type { S3WireOptions } from './driver-s3-signed';
import { partBytesFor } from './multipart';
import type { PutStreamOptions } from './put-stream';
import { streamLimit } from './put-stream';

export interface S3PutStreamInput extends Pick<S3UploadTarget, 'key' | 'refused'> {
  readonly body: ReadableStream<Uint8Array>;
  readonly options: PutStreamOptions;
  readonly maxBytes: number;
  readonly driver: string;
  /** The disk's HEAD, asked only when a last request's answer was lost. */
  readonly stat: S3Stat;
}

/** The whole body, stored — or nothing stored and the key as it was. */
export async function putS3Stream(wire: S3WireOptions, input: S3PutStreamInput): Promise<void> {
  const { key, body, options, maxBytes, driver, refused, stat } = input;
  const target: S3UploadTarget = { wire, key, refused };
  const putOptions: PutOptions = options;
  // Screened before a byte is read: a header that cannot travel fails here, not on the Create.
  const headers = objectHeaders(putOptions);
  const partBytes = partBytesFor(maxBytes);
  let chunks: Uint8Array[] = [];
  let held = 0;
  let total = 0;
  let uploadId: string | undefined;
  const etags: string[] = [];

  const sendPart = async (): Promise<void> => {
    uploadId ??= await createS3Upload(target, headers);
    const part = new Uint8Array(Bun.concatArrayBuffers(chunks));
    chunks = [];
    held = 0;
    etags.push(await uploadS3Part(target, uploadId, etags.length + 1, part));
  };

  try {
    await pumpBounded(body, streamLimit(driver, key, maxBytes), async (chunk) => {
      chunks.push(chunk);
      held += chunk.byteLength;
      total += chunk.byteLength;
      if (held >= partBytes) await sendPart();
    });
    if (uploadId === undefined) {
      const whole = new Uint8Array(Bun.concatArrayBuffers(chunks));
      const rethrow = (error: unknown): never => {
        throw error;
      };
      const refusal = await signedPut(wire, key, whole, putOptions).catch(
        settleLostPut(stat, { driver, key, bytes: whole, attributes: options }, rethrow),
      );
      if (refusal !== undefined) refused(refusal);
      return;
    }
    if (held > 0) await sendPart();
    const open = uploadId;
    await completeS3Upload(
      target,
      open,
      etags.map((etag, at) => ({ partNumber: at + 1, etag })),
    ).catch(async (lost: unknown) => {
      if (isAnswered(lost)) throw lost;
      // Settled here, abort included, so the catch below must not abort a second time.
      uploadId = undefined;
      const sent = sentObject(total, multipartEtagOf(etags), options);
      await settleComplete(stat, { ...target, driver }, open, sent, lost);
    });
  } catch (error) {
    // Parts bill until they are aborted. The refusal the caller reads is the first one, so an abort
    // that fails too is left to the bucket's lifecycle rule rather than replacing it.
    if (uploadId !== undefined) await abortS3Upload(target, uploadId).catch(() => undefined);
    throw error;
  }
}
