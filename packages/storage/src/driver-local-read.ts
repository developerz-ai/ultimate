// Single responsibility: what the local disk KNOWS about one object — its bytes file, its sidecar,
// and the pending marker that says whether the two can be trusted as a pair. A write that died
// between its renames leaves a sidecar describing bytes that never landed; this is where that is
// read as "type unknown" instead of served as the truth.

import { renderFixShellArg, stringField } from '@ultimat3/core';
import type { StorageListEntry } from './driver';
import { parseSidecar, type Sidecar } from './driver-local-sidecar';
import { pendingPathOf, sidecarPathOf } from './driver-local-write';
import { isStorageError, objectNotFound, readFailed } from './errors';

async function readSidecar(root: string, key: string): Promise<Sidecar | undefined> {
  const file = Bun.file(`${root}/${sidecarPathOf(key)}`);
  if (!(await file.exists())) return undefined;
  try {
    const raw: unknown = await file.json();
    return parseSidecar(raw);
  } catch {
    return undefined;
  }
}

/** The etag a write in flight — or one that died — announced before it moved anything. */
async function pendingEtag(root: string, key: string): Promise<string | undefined> {
  const file = Bun.file(`${root}/${pendingPathOf(key)}`);
  if (!(await file.exists())) return undefined;
  return (await file.text().catch(() => '')).trim();
}

/**
 * A read the OS refused, coded: `EACCES`, `EIO`, a directory where the bytes should be. A file
 * that is simply gone — deleted between the `exists()` and the read — is "not found", as it
 * would have been one call earlier.
 */
const refusedRead =
  (root: string, key: string, disk: string) =>
  (error: unknown): never => {
    if (isStorageError(error)) throw error;
    throw stringField(error, 'code') === 'ENOENT'
      ? objectNotFound(disk, key)
      : readFailed(
          'local',
          key,
          error,
          `ls -l ${renderFixShellArg(`${root}/${key}`, '<the object file>')}`,
        );
  };

/**
 * The whole object, buffered — `get()`'s one read. `disk` is the name `defineStorage` registered,
 * because a not-found `fix:` is `disk('<it>').list(…)`; `local` only for a driver nobody named.
 */
export async function readObjectBytes(
  root: string,
  key: string,
  disk = 'local',
): Promise<Uint8Array> {
  return Bun.file(`${root}/${key}`)
    .arrayBuffer()
    .then((buffer) => new Uint8Array(buffer), refusedRead(root, key, disk));
}

/** `etagOf`, streamed: a copy or a `stat()` must settle a doubt without buffering the object. */
export async function etagOfFile(root: string, key: string, disk = 'local'): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  try {
    for await (const chunk of Bun.file(`${root}/${key}`).stream()) hasher.update(chunk);
  } catch (error) {
    return refusedRead(root, key, disk)(error);
  }
  return hasher.digest('hex').slice(0, 32);
}

/**
 * One object's facts, or `undefined` when there are no bytes at the key — the bytes file is what
 * makes an object exist, so a sidecar alone (a fresh write that died early) is nothing at all.
 *
 * The sidecar is TRUSTED unless the pending marker names its etag: that is the one state in which
 * the sidecar is the new write's and the bytes may still be the old object's. Then, and for an
 * object with no sidecar, the answer depends on `trueEtag`:
 * - absent (a listing, which never reads bytes): no content type, `etag: ''` — "cannot know";
 * - given: the bytes decide. A match keeps the sidecar; a mismatch drops every field it claimed
 *   and reports the bytes' own etag.
 *
 * No path here answers a type or an etag the bytes were not checked against while in doubt.
 */
export async function headObject(
  root: string,
  key: string,
  trueEtag?: () => string | Promise<string>,
): Promise<StorageListEntry | undefined> {
  const file = Bun.file(`${root}/${key}`);
  if (!(await file.exists())) return undefined;
  const recorded = await readSidecar(root, key);
  const inDoubt = recorded !== undefined && (await pendingEtag(root, key)) === recorded.etag;
  let sidecar = recorded;
  let etag = recorded?.etag ?? '';
  if (recorded === undefined || inDoubt) {
    etag = trueEtag === undefined ? '' : await trueEtag();
    if (recorded?.etag !== etag) sidecar = undefined;
  }
  return {
    key,
    size: file.size,
    etag,
    lastModified: new Date(file.lastModified),
    ...(sidecar?.contentType === undefined ? {} : { contentType: sidecar.contentType }),
    ...(sidecar?.cacheControl === undefined ? {} : { cacheControl: sidecar.cacheControl }),
    ...(sidecar?.metadata === undefined ? {} : { metadata: sidecar.metadata }),
  };
}
