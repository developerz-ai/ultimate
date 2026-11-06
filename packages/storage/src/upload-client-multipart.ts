// Single responsibility: the browser half of an upload in parts — grant (or resume), PUT each part
// at its own signed URL with bounded concurrency and core's retry, then complete. Browser-safe as
// `upload-client.ts` is: no `Bun.*`, no `node:`, no driver import, and every network call is either
// the app's typed action or the one `SignedPut` seam.

import { finiteCount, retry } from '@ultimat3/core';
import { uploadFailed } from './errors';
import type { UploadRequest } from './grant';
import type { MultipartGrant } from './grant-multipart';
import type { CompletedPart, UploadedPart } from './multipart';
import type { SignedPut, UploadProgress, UploadSource } from './upload-client';

/** One open session, as each of the app's calls names it. */
export interface UploadSessionRef {
  readonly key: string;
  readonly uploadId: string;
}

/**
 * The app's typed action calls, each wrapping one server function of `grant-multipart.ts` under the
 * app's own policy — the reason `grant` is the app's in `uploadFile`.
 */
export interface MultipartUploadClient {
  readonly grant: (request: UploadRequest) => Promise<MultipartGrant>;
  readonly signPart: (
    input: UploadSessionRef & { readonly partNumber: number; readonly size: number },
  ) => Promise<string>;
  readonly listParts: (input: UploadSessionRef) => Promise<readonly UploadedPart[]>;
  /** Etags are read on the server (`completeUpload`), so no bucket CORS has to expose `ETag`. */
  readonly complete: (
    input: UploadSessionRef & { readonly parts: readonly CompletedPart[] },
  ) => Promise<unknown>;
  /** Called when the caller's `signal` aborts: a cancelled upload leaves no parts billing. */
  readonly abort: (input: UploadSessionRef) => Promise<unknown>;
  /** At or under this, one PUT as before. Default 64 MiB. */
  readonly partThresholdBytes?: number | undefined;
  /**
   * A grant from an earlier, interrupted call for the same file: its parts are listed first and only
   * the missing ones are sent. Persisting it is the caller's — this file keeps no browser storage.
   */
  readonly resume?: MultipartGrant | undefined;
  /** Handed the grant before any part moves, so the caller can persist it for `resume`. */
  readonly onGrant?: ((grant: MultipartGrant) => void) | undefined;
  /** Test seam for the retry waits. Defaults to a timer. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export const DEFAULT_PART_THRESHOLD_BYTES = 64 * 1024 * 1024;
/** Parts in flight at once: enough to fill a phone's uplink, few enough to keep its memory. */
export const PART_CONCURRENCY = 4;
const PART_RETRY = { attempts: 4, base: 500, max: 8_000, jitter: 'full' } as const;

export const partThresholdOf = (client: MultipartUploadClient): number =>
  finiteCount(
    'uploadFile',
    'multipart.partThresholdBytes',
    client.partThresholdBytes === undefined
      ? DEFAULT_PART_THRESHOLD_BYTES
      : client.partThresholdBytes,
    1,
  );

export interface MultipartUploadInput {
  readonly file: UploadSource;
  readonly client: MultipartUploadClient;
  readonly put: SignedPut;
  readonly onProgress?: ((progress: UploadProgress) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** A grant for this file, or the resumed one; a resume for another size is a different file. */
async function sessionFor(input: MultipartUploadInput): Promise<MultipartGrant> {
  const { file, client } = input;
  const resumed = client.resume;
  if (resumed !== undefined && resumed.size === file.size) return resumed;
  const grant = await client.grant({
    filename: file.name,
    contentType: file.type,
    size: file.size,
  });
  client.onGrant?.(grant);
  return grant;
}

/** Send every part not yet on the disk, then complete. Answers the grant the object landed under. */
export async function uploadInParts(input: MultipartUploadInput): Promise<MultipartGrant> {
  const { file, client, put, signal } = input;
  const grant = await sessionFor(input);
  const session = { key: grant.key, uploadId: grant.uploadId };
  const total = file.size;
  const count = Math.ceil(total / grant.partBytes);
  const landed = client.resume === grant ? await client.listParts(session) : [];
  const have = new Set(
    landed
      .filter(
        (part) =>
          part.size === Math.min(grant.partBytes, total - (part.partNumber - 1) * grant.partBytes),
      )
      .map((part) => part.partNumber),
  );
  let confirmed = landed
    .filter((part) => have.has(part.partNumber))
    .reduce((sum, part) => sum + part.size, 0);
  input.onProgress?.({ loaded: confirmed, total, ratio: total > 0 ? confirmed / total : 0 });

  const missing: number[] = [];
  for (let number = 1; number <= count; number += 1) if (!have.has(number)) missing.push(number);

  const cancelled = () => uploadFailed(grant.key, 0, 'the upload was aborted');
  // A rejected wait ends core's retry loop with that error: a cancelled upload stops retrying.
  const waitUnlessAborted = (ms: number): Promise<void> =>
    signal?.aborted === true
      ? Promise.reject(cancelled())
      : (client.sleep ?? ((wait) => new Promise<void>((done) => setTimeout(done, wait))))(ms);

  const sendPart = async (partNumber: number): Promise<void> => {
    const start = (partNumber - 1) * grant.partBytes;
    const body = file.slice(start, Math.min(start + grant.partBytes, total));
    await retry(
      async () => {
        const url = await client.signPart({ ...session, partNumber, size: body.size });
        await put({
          url,
          contentType: grant.contentType,
          body,
          ...(signal === undefined ? {} : { signal }),
        });
      },
      PART_RETRY,
      { sleep: waitUnlessAborted },
    );
    confirmed += body.size;
    input.onProgress?.({ loaded: confirmed, total, ratio: total > 0 ? confirmed / total : 0 });
  };

  const worker = async (): Promise<void> => {
    for (let next = missing.shift(); next !== undefined; next = missing.shift()) {
      if (signal?.aborted === true) return;
      await sendPart(next);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, missing.length) }, worker));
    if (signal?.aborted === true) throw cancelled();
  } catch (error) {
    // Cancelled is abandoned: the parts are dropped now rather than billing until a sweep. Any
    // other failure keeps the session open, so the same grant passed as `resume` sends only what
    // is missing. A refused abort is the sweep's to reclaim (`abortStaleUploads`), and the
    // caller hears the failure that stopped the upload, not the clean-up's.
    if (signal?.aborted === true) await client.abort(session).catch(() => undefined);
    throw error;
  }
  const parts = Array.from({ length: count }, (_, at) => ({ partNumber: at + 1 }));
  await client.complete({ ...session, parts });
  return grant;
}
