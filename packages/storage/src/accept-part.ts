// Single responsibility: the one decision a part PUT on `/_storage` is made of, on a disk that signs
// its own part URLs — verified, held to the actor's tenant, held to the exact signed length, then
// handed to the disk's open session. Transport-free, as `accept.ts` is: the route owns the request.

import { type SignedRequestInput, signedUploadConstraints } from './accept';
import { signedUrlRejected, tooLarge } from './errors';
import { multipartUnsupported } from './errors-multipart';
import type { UploadedPart } from './multipart';

export interface AcceptSignedPartInput extends SignedRequestInput {
  readonly bytes: Uint8Array;
}

/**
 * Store one part, or refuse. The URL must be a part URL — a single PUT's URL is
 * `acceptSignedUpload`'s — and the disk must keep parts itself (`multipart.receivePart`); an s3
 * part never reaches this process. An upload that is not open is `X_STORAGE_UPLOAD_UNKNOWN`.
 */
export async function acceptSignedPart(input: AcceptSignedPartInput): Promise<UploadedPart> {
  const constraints = await signedUploadConstraints(input);
  const { key, part, maxBytes } = constraints;
  if (part === undefined) {
    throw signedUrlRejected('not-a-part', `"${key}" was signed for the object, not one part`);
  }
  const size = input.bytes.byteLength;
  if (maxBytes !== undefined && size > maxBytes) throw tooLarge(key, size, maxBytes);
  // Exact, as s3 holds a part to its signed `content-length`: a short part would pass here and
  // fail in production, and a Complete would then assemble an object of the wrong size.
  if (size !== part.length) {
    throw signedUrlRejected(
      'length-mismatch',
      `part ${part.partNumber} of "${key}" is ${size}B and the signature covers ${String(part.length)}B`,
    );
  }
  const receive = input.disk.multipart?.receivePart;
  if (receive === undefined) throw multipartUnsupported(input.disk.name, key);
  return receive.call(input.disk.multipart, key, part.uploadId, part.partNumber, input.bytes);
}
