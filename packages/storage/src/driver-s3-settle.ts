// Single responsibility: what a write whose answer was lost actually did. The last request went out
// and the socket died, so the provider may have stored the object. Settled by a stat against what
// was sent, and for a multipart upload by an abort, whose answer says whether it was still open.
// What neither can settle is `X_STORAGE_WRITE_OUTCOME_UNKNOWN`, never a refusal the disk did not make.

import { isUltimateError, stringField } from '@ultimat3/core';
import { DEFAULT_CONTENT_TYPE, type PutOptions } from './driver';
import { abortS3Upload, type S3UploadTarget } from './driver-s3-multipart';
import { writeOutcomeUnknown } from './errors-stream';

/** The disk's own HEAD: `undefined` for nothing there. A throw is a stat that could not answer. */
export type S3Stat = (
  key: string,
) => Promise<
  { readonly size: number; readonly etag: string; readonly contentType: string } | undefined
>;

export interface SentObject {
  readonly size: number;
  /** The etag the provider gives exactly these bytes, unquoted; `undefined` when it cannot be known. */
  readonly etag: string | undefined;
  readonly contentType: string;
  /**
   * The write set something a HEAD does not read back (metadata, cache-control, a lock). Then a
   * match proves only the bytes, which an overwrite of the same bytes matches already: unknown.
   */
  readonly unverifiable: boolean;
}

/** What a write said about the object, beyond its bytes. */
export interface SentAttributes
  extends Pick<PutOptions, 'contentType' | 'cacheControl' | 'metadata'> {
  readonly retention?: unknown;
  readonly legalHold?: unknown;
}

/** `SentObject` for `size` bytes of `etag` under `attributes`. */
export const sentObject = (
  size: number,
  etag: string | undefined,
  attributes: SentAttributes | undefined,
): SentObject => ({
  size,
  etag,
  contentType: attributes?.contentType ?? DEFAULT_CONTENT_TYPE,
  unverifiable:
    attributes?.metadata !== undefined ||
    attributes?.cacheControl !== undefined ||
    attributes?.retention !== undefined ||
    attributes?.legalHold !== undefined,
});

const unquoted = (etag: string): string => etag.replace(/^W\//, '').replaceAll('"', '');

const md5Hex = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher('md5').update(bytes).digest('hex');

/** A single PUT's etag: the body's MD5. A provider encrypting with KMS mints another, so no match. */
export const putEtagOf = (bytes: Uint8Array): string => md5Hex(bytes);

/**
 * S3's multipart etag: the MD5 of the parts' binary MD5s, then `-<count>`. Measured equal on the test
 * stack's gateway. A part etag that is not an MD5 (KMS) makes it unknowable, never a guess.
 */
export function multipartEtagOf(partEtags: readonly string[]): string | undefined {
  const digests: Uint8Array[] = [];
  for (const etag of partEtags) {
    const hex = unquoted(etag);
    if (!/^[0-9a-f]{32}$/i.test(hex)) return undefined;
    digests.push(Uint8Array.fromHex(hex));
  }
  return `${md5Hex(new Uint8Array(Bun.concatArrayBuffers(digests)))}-${partEtags.length}`;
}

/** `true` when the key holds what was sent, `false` when it holds something else, `undefined` unknown. */
async function holds(stat: S3Stat, key: string, sent: SentObject): Promise<boolean | undefined> {
  let found: Awaited<ReturnType<S3Stat>>;
  try {
    found = await stat(key);
  } catch {
    return undefined;
  }
  if (found === undefined) return false;
  if (sent.etag === undefined || sent.unverifiable) return undefined;
  return (
    found.size === sent.size &&
    unquoted(found.etag) === sent.etag &&
    found.contentType === sent.contentType
  );
}

/**
 * Whether a failed write is the provider ANSWERING (a refusal, already coded or Bun's `S3Error`) or
 * the answer lost on the wire, after which the object may be stored.
 */
export const isAnswered = (error: unknown): boolean =>
  isUltimateError(error) || stringField(error, 'name') === 'S3Error';

/**
 * The `.catch` for a single PUT: a provider answer goes to `refused`, a lost one is settled, so
 * `put()` resolves when the object landed and is `X_STORAGE_WRITE_OUTCOME_UNKNOWN` when unproven.
 */
export const settleLostPut =
  (
    stat: S3Stat,
    input: {
      readonly driver: string;
      readonly key: string;
      readonly bytes: Uint8Array;
      readonly attributes: SentAttributes | undefined;
    },
    refused: (error: unknown) => never,
  ) =>
  async (error: unknown): Promise<undefined> => {
    if (isAnswered(error)) return refused(error);
    const sent = sentObject(input.bytes.byteLength, putEtagOf(input.bytes), input.attributes);
    await settlePut(stat, { driver: input.driver, key: input.key, lost: error }, sent);
    return undefined;
  };

/** A lost single PUT. It cannot be aborted, so only a match settles it. */
export async function settlePut(
  stat: S3Stat,
  input: { readonly driver: string; readonly key: string; readonly lost: unknown },
  sent: SentObject,
): Promise<void> {
  if ((await holds(stat, input.key, sent)) === true) return;
  throw writeOutcomeUnknown(input.driver, input.key, input.lost);
}

/**
 * A lost Complete. Resolves when the object landed; rethrows `lost` when the abort proves the upload
 * was still open, so nothing was stored and the caller's refusal is the truth.
 */
export async function settleComplete(
  stat: S3Stat,
  target: S3UploadTarget & { readonly driver: string },
  uploadId: string,
  sent: SentObject,
  lost: unknown,
): Promise<void> {
  if ((await holds(stat, target.key, sent)) === true) return;
  const refusal = await abortS3Upload(target, uploadId).catch(() => 'unanswered' as const);
  if (refusal === undefined) throw lost;
  // NoSuchUpload: nothing is open, so the Complete finished. Whether with these bytes, the key says.
  if (refusal !== 'unanswered' && refusal.statusCode === 404) {
    if ((await holds(stat, target.key, sent)) === true) return;
  }
  throw writeOutcomeUnknown(target.driver, target.key, lost);
}
