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
import { MAX_PART_BYTES } from './multipart';
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

/** A part's size before growth: big enough to amortise a request, small enough to hold four. */
export const STREAM_PART_BYTES = 8 * 1024 * 1024;
/** Parts in flight AND being filled, together: what one `putStream` holds is at most this many parts. */
export const STREAM_PART_BUFFERS = 4;
/** Parts per size step: the size doubles every 1,000, so 10,000 parts reach 8 TiB, past S3's 5 TiB. */
const PARTS_PER_STEP = 1000;
/** The first buffer for a body that may yet fit one PUT: grown by doubling, never preallocated. */
const FIRST_BUFFER_BYTES = 64 * 1024;

/**
 * Part `n`'s size: `STREAM_PART_BYTES`, doubled every 1,000 parts, capped at S3's 5 GiB part. Never
 * derived from the declared ceiling, which made a 1 TB `maxBytes` cut 100 MB parts for every body.
 */
export function streamPartBytes(partNumber: number): number {
  // A size schedule, not a retry curve: doubled once per 1,000 parts while it stays a legal part.
  let size = STREAM_PART_BYTES;
  for (let past = PARTS_PER_STEP; past < partNumber; past += PARTS_PER_STEP) {
    if (size + size > MAX_PART_BYTES) break;
    size += size;
  }
  return size;
}

/** The whole body, stored — or nothing stored and the key as it was. */
export async function putS3Stream(wire: S3WireOptions, input: S3PutStreamInput): Promise<void> {
  const { key, body, options, maxBytes, driver, refused, stat } = input;
  const target: S3UploadTarget = { wire, key, refused };
  const putOptions: PutOptions = options;
  // Screened before a byte is read: a header that cannot travel fails here, not on the Create.
  const headers = objectHeaders(putOptions);
  // ONE buffer per part, chunks copied in: a chunk is never held beside the part it went into.
  let buffer = new Uint8Array(FIRST_BUFFER_BYTES);
  let filled = 0;
  let total = 0;
  let uploadId: string | undefined;
  const etags: string[] = [];
  const inFlight = new Set<Promise<void>>();
  /** The first refused part, if any; later ones add nothing the caller can act on. */
  const failures: unknown[] = [];

  const dispatch = async (part: Uint8Array): Promise<void> => {
    uploadId ??= await createS3Upload(target, headers);
    const open = uploadId;
    const partNumber = etags.length + 1;
    etags.push('');
    const sending = uploadS3Part(target, open, partNumber, part).then(
      (etag) => {
        etags[partNumber - 1] = etag;
      },
      (error: unknown) => {
        failures.push(error);
      },
    );
    const tracked = sending.finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
    // A new buffer only once one is free: in flight plus filling stays at `STREAM_PART_BUFFERS`.
    while (inFlight.size >= STREAM_PART_BUFFERS) await Promise.race(inFlight);
    if (failures.length > 0) throw failures[0];
  };

  const append = async (chunk: Uint8Array): Promise<void> => {
    let at = 0;
    while (at < chunk.byteLength) {
      const partBytes = streamPartBytes(etags.length + 1);
      if (filled === buffer.byteLength && buffer.byteLength < partBytes) {
        // Still the first part: grown by doubling, so a small body never costs a whole part.
        const grown = new Uint8Array(Math.min(partBytes, buffer.byteLength * 2));
        grown.set(buffer.subarray(0, filled));
        buffer = grown;
      }
      const taken = Math.min(chunk.byteLength - at, buffer.byteLength - filled);
      buffer.set(chunk.subarray(at, at + taken), filled);
      filled += taken;
      at += taken;
      if (filled === partBytes) {
        filled = 0;
        await dispatch(buffer);
        // Allocated once a slot is free, never before: the bound is on buffers, not requests.
        buffer = new Uint8Array(streamPartBytes(etags.length + 1));
      }
    }
  };

  try {
    await pumpBounded(body, streamLimit(driver, key, maxBytes), async (chunk) => {
      total += chunk.byteLength;
      await append(chunk);
    });
    if (uploadId === undefined && inFlight.size === 0) {
      const whole = buffer.subarray(0, filled);
      const rethrow = (error: unknown): never => {
        throw error;
      };
      const refusal = await signedPut(wire, key, whole, putOptions).catch(
        settleLostPut(stat, { driver, key, bytes: whole, attributes: options }, rethrow),
      );
      if (refusal !== undefined) refused(refusal);
      return;
    }
    if (filled > 0) await dispatch(buffer.subarray(0, filled));
    await Promise.all(inFlight);
    if (failures.length > 0) throw failures[0];
    const open = uploadId;
    if (open === undefined) return;
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
    // A part still sending would land after the abort and bill: every one settles first. The
    // refusal the caller reads is the first one, so an abort that fails too is left to the
    // bucket's lifecycle rule rather than replacing it.
    await Promise.allSettled(inFlight);
    if (uploadId !== undefined) await abortS3Upload(target, uploadId).catch(() => undefined);
    throw error;
  }
}
