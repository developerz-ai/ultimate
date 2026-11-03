// The two refusals only a bounded sniff can reach: markup that could sit past what was read. Their
// code is `X_STORAGE_TYPE_REJECTED`, registered with the rest of the package's in `errors.ts`; they
// are their own constructors because the sniff saw nothing to name, so `contentTypeMismatch`'s
// "re-upload with the sniffed type" would be advice about a type nobody found.

import { renderFixLiteral } from '@ultimat3/core';
import { StorageError } from './errors';

/**
 * A body opening with more whitespace than `limit` bytes. Past a window nothing is seen, so padding
 * is how markup would hide from a head read, and no real file opens this way.
 */
export const leadingWhitespacePastLimit = (
  key: string,
  declared: string,
  limit: number,
): StorageError =>
  new StorageError({
    code: 'X_STORAGE_TYPE_REJECTED',
    cause: `"${key}" declares ${declared} and opens with more than ${limit} bytes of whitespace, so its type cannot be read`,
    fix: `validateUpload({ key: ${renderFixLiteral(key, "'a/file.txt'")}, declaredContentType: ${renderFixLiteral(declared, "'text/plain'")}, bytes: new TextEncoder().encode(text.trimStart()) }, policy) — where text is the file with its leading whitespace removed`,
    meta: { key, declared, limit },
  });

/**
 * An XML document too long for a head window to screen: XML runs a script anywhere in the tree, so
 * no prefix can clear it. The server-side path reads all of it, which is the way through.
 */
export const xmlBodyPastWindow = (key: string, declared: string, window: number): StorageError =>
  new StorageError({
    code: 'X_STORAGE_TYPE_REJECTED',
    cause: `"${key}" declares ${declared} and is over the ${window} bytes promotion reads, and an XML document can run a script anywhere in it`,
    fix: `validateUpload({ key: ${renderFixLiteral(key, "'a/data.xml'")}, declaredContentType: ${renderFixLiteral(declared, "'application/xml'")}, bytes }, policy) — upload it through the server, which reads the whole body, then disk.put(key, bytes, { contentType })`,
    meta: { key, declared, window },
  });
