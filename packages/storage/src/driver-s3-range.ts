// Single responsibility: the s3 disk's ranged read — ONE signed GET whose `Range:` answer carries
// the bytes AND what they are (`Content-Range`'s window and total size, `ETag`, type, date), so the
// slice and its description come from one response about one version. A HEAD beside it could not
// promise that: a write between the two, or an A → B → A overwrite of one length, slips past both.

import type { StorageObject, StorageRead } from './driver';
import { DEFAULT_CONTENT_TYPE } from './driver';
import { type S3Refusal, type S3WireOptions, sendSigned } from './driver-s3-signed';
import { rangeTooLarge, rangeUnsatisfiable } from './errors-range';
import type { ByteRange } from './range';

/** What the driver lends this read: its coded refusals and its own HEAD for a 416's size. */
export interface S3RangeDeps {
  readonly driver: string;
  readonly maxGetBytes: number;
  /** A refusal the provider gave (403, 503, a wrong region, a 404) as the disk's coded error. */
  readonly refused: (key: string, refusal: S3Refusal) => never;
  /** The disk's HEAD — asked only after a 416, for the size the refusal names. */
  readonly sizeOf: (key: string) => Promise<number>;
  /** A response the read cannot use: no `Content-Range`, or one that is not the window asked. */
  readonly unreadable: (key: string, why: string) => never;
}

const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/;

/**
 * The window asked, CAPPED at `maxGetBytes` before it is sent: the ceiling bounds the range, and the
 * object's size is not known until the answer — so at most the ceiling crosses the wire, and an
 * answer that shows the object went on past the cap is refused before its body is read.
 */
export async function readS3Range(
  wire: S3WireOptions,
  key: string,
  range: ByteRange,
  deps: S3RangeDeps,
): Promise<StorageRead> {
  const [first, last] = range;
  const capped = Math.min(last, first + deps.maxGetBytes - 1);
  const result = await sendSigned(wire, {
    method: 'GET',
    key,
    headers: { range: `bytes=${first}-${capped}` },
  });
  if (!result.ok) {
    if (result.refusal.statusCode !== 416) return deps.refused(key, result.refusal);
    // A first byte at or past the end — of the object as it is NOW, which the HEAD names.
    throw rangeUnsatisfiable(deps.driver, key, range, await deps.sizeOf(key));
  }
  const { response } = result;
  const window = CONTENT_RANGE.exec(response.headers.get('content-range') ?? '');
  if (response.status !== 206 || window === null) {
    await response.body?.cancel().catch(() => undefined);
    return deps.unreadable(key, `the ranged GET answered ${response.status} with no byte range`);
  }
  const served: ByteRange = [Number(window[1]), Number(window[2])];
  const size = Number(window[3]);
  if (served[0] !== first || served[1] > capped) {
    await response.body?.cancel().catch(() => undefined);
    return deps.unreadable(
      key,
      `asked bytes ${first}-${capped}, answered ${served[0]}-${served[1]}`,
    );
  }
  // Cut by the CAP, not by the end of the object: the range asked is over the ceiling.
  if (last > capped && size - 1 > capped) {
    await response.body?.cancel().catch(() => undefined);
    throw rangeTooLarge(deps.driver, key, [first, Math.min(last, size - 1)], deps.maxGetBytes);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== served[1] - served[0] + 1) {
    return deps.unreadable(
      key,
      `Content-Range promised ${served[1] - served[0] + 1}B, the body held ${bytes.byteLength}B`,
    );
  }
  return { object: objectOf(key, size, response.headers), bytes, range: served };
}

/** The WHOLE object, as the same response describes it — never a second request's view. */
function objectOf(key: string, size: number, headers: Headers): StorageObject {
  const modified = new Date(headers.get('last-modified') ?? '');
  return {
    key,
    size,
    contentType: headers.get('content-type') ?? DEFAULT_CONTENT_TYPE,
    etag: headers.get('etag') ?? '',
    // Omitted when the provider sent none, never epoch 0 — `StorageListEntry.lastModified`.
    ...(Number.isFinite(modified.getTime()) ? { lastModified: modified } : {}),
  };
}
