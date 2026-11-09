// Single responsibility: an s3 copy past CopyObject's 5 GiB ceiling — a signed HEAD for the
// source's own headers and revision, CreateMultipartUpload carrying those headers, UploadPartCopy
// over byte ranges all pinned to that one revision, then Complete. Every exit but a landed Complete
// aborts the upload, so a failed copy leaves no parts billing.

import { copySourceOf, MAX_COPY_OBJECT_BYTES, signedCopy } from './driver-s3-copy';
import {
  abortS3Upload,
  completeS3Upload,
  createS3Upload,
  type S3UploadTarget,
  xmlText,
} from './driver-s3-multipart';
import {
  isAnswered,
  multipartEtagOf,
  type S3Stat,
  sentObject,
  settleComplete,
} from './driver-s3-settle';
import { type S3Refusal, type S3WireOptions, sendSigned, xmlField } from './driver-s3-signed';

/** The smallest part a large copy cuts: 512 MiB, so 5 TiB (S3's object ceiling) fits 10,000. */
export const COPY_PART_BYTES = 512 * 1024 ** 2;
const MAX_PARTS = 10_000;
/** UploadPartCopy is server-side, so this bounds requests in flight, never bytes held. */
const COPY_CONCURRENCY = 4;

/** The headers CopyObject's COPY directive carries, which a multipart Create must restate. */
const CARRIED = [
  'content-type',
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'expires',
] as const;

export interface S3PartCopy {
  readonly source: string;
  /** The caller's revision; absent, the HEAD's own etag pins every part to one revision. */
  readonly ifMatch?: string | undefined;
  /** The disk's HEAD, asked only when the Complete's answer was lost. */
  readonly stat: S3Stat;
  /** Injected in tests; production cuts `COPY_PART_BYTES` or `size / 10,000`, the larger. */
  readonly partBytes?: number | undefined;
}

/** The part size: the floor, grown only when 10,000 of it cannot hold the object. */
export const copyPartBytes = (size: number, floor = COPY_PART_BYTES): number =>
  Math.max(floor, Math.ceil(size / MAX_PARTS));

/** Copy `source` onto `target.key` in parts. A refusal goes to `target.refused`, never bare. */
export async function copyS3InParts(target: S3UploadTarget, copy: S3PartCopy): Promise<void> {
  const { wire, refused } = target;
  const head = await sendSigned(wire, {
    method: 'HEAD',
    key: copy.source,
    headers: copy.ifMatch === undefined ? {} : { 'if-match': copy.ifMatch },
  });
  if (!head.ok) return refused(head.refusal);
  const answer = head.response.headers;
  const size = Number(answer.get('content-length') ?? Number.NaN);
  if (!Number.isSafeInteger(size) || size < 0) {
    return refused({
      name: 'S3Error',
      code: 'UnreadableAnswer',
      message: 'the HEAD before a multipart copy carried no Content-Length',
      statusCode: 200,
    });
  }
  const etag = answer.get('etag') ?? copy.ifMatch;
  const headers: Record<string, string> = {};
  answer.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('x-amz-meta-') || (CARRIED as readonly string[]).includes(lower)) {
      headers[lower] = value;
    }
  });
  const uploadId = await createS3Upload(target, headers);
  const step = copyPartBytes(size, copy.partBytes);
  const count = Math.max(1, Math.ceil(size / step));
  const etags: string[] = new Array(count);
  // Set by the first refused part: its siblings take no new range, and every one in flight settles
  // before the abort — a part landing after it would bill against an upload nobody can see.
  let stopped = false;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < count && !stopped; index = next++) {
      const first = index * step;
      const last = Math.min(size, first + step) - 1;
      try {
        etags[index] = await copyPart(target, uploadId, index + 1, {
          'x-amz-copy-source': copySourceOf(wire, copy.source),
          'x-amz-copy-source-range': `bytes=${first}-${last}`,
          ...(etag === undefined ? {} : { 'x-amz-copy-source-if-match': etag }),
        });
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };
  let settled = false;
  try {
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(COPY_CONCURRENCY, count) }, worker),
    );
    const failed = workers.find((outcome) => outcome.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
    const parts = etags.map((partEtag, index) => ({ partNumber: index + 1, etag: partEtag }));
    await completeS3Upload(target, uploadId, parts).catch(async (lost: unknown) => {
      if (isAnswered(lost)) throw lost;
      // The answer was lost, not refused: the copy may have landed. Settled — abort included — by
      // the disk's stat, exactly as a streamed put's lost Complete is.
      settled = true;
      const sent = sentObject(size, multipartEtagOf(etags), {
        contentType: headers['content-type'],
        cacheControl: headers['cache-control'],
        metadata: Object.keys(headers).some((name) => name.startsWith('x-amz-meta-'))
          ? {}
          : undefined,
      });
      await settleComplete(copy.stat, { ...target, driver: 's3' }, uploadId, sent, lost);
    });
  } catch (error) {
    if (!settled) await abortS3Upload(target, uploadId).catch(() => undefined);
    throw error;
  }
}

/** One UploadPartCopy, answering its etag — read off the body, where S3 puts it for a copy. */
async function copyPart(
  { wire, key, refused }: S3UploadTarget,
  uploadId: string,
  partNumber: number,
  headers: Readonly<Record<string, string>>,
): Promise<string> {
  const result = await sendSigned(wire, {
    method: 'PUT',
    key,
    query: { partNumber: String(partNumber), uploadId },
    headers,
  });
  if (!result.ok) return refused(result.refusal);
  const body = await result.response.text();
  const etag = xmlField(body, 'ETag');
  if (body.includes('<Error>') || etag === undefined) {
    return refused({
      name: 'S3Error',
      code: xmlField(body, 'Code') ?? 'UnreadableAnswer',
      message: xmlField(body, 'Message') ?? 'UploadPartCopy answered with no ETag',
      statusCode: 200,
    });
  }
  return xmlText(etag);
}

/** One copy, either way: CopyObject up to its 5 GiB ceiling, parts past it. Refusals to `refused`. */
export async function copyS3(
  wire: S3WireOptions,
  copy: {
    readonly source: string;
    readonly destination: string;
    readonly ifMatch: string | undefined;
    readonly size: number;
    readonly stat: S3Stat;
  },
  refused: (refusal: S3Refusal) => never,
): Promise<void> {
  if (copy.size > MAX_COPY_OBJECT_BYTES) {
    const target = { wire, key: copy.destination, refused };
    return copyS3InParts(target, { source: copy.source, ifMatch: copy.ifMatch, stat: copy.stat });
  }
  const refusal = await signedCopy(wire, copy.source, copy.destination, copy.ifMatch);
  if (refusal !== undefined) refused(refusal);
}
