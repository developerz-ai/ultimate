// The sweep's deletes, fenced against a publish that lands after its last manifest read: the disk
// has no conditional delete, so each file's bytes are held across its delete, the manifests are
// read once more AFTER it, and every file a manifest now names is put back.

import { isUltimateError } from '@ultimat3/core';
import type { RetainedScope, StoredManifest } from './retained-assets-layout';
import { inBatches, readManifests, retainedFileKey } from './retained-assets-layout';

/** Files deleted per fence: the bytes held between a delete and its fence stay bounded. */
const FENCE_CHUNK = 64;

interface Held {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

const isCode = (error: unknown, code: string): boolean =>
  isUltimateError(error) && error.code === code;

/** The file's bytes, or `undefined` when it is gone or too large to hold — then it is spared. */
async function hold(scope: RetainedScope, key: string): Promise<Held | undefined> {
  try {
    const read = await scope.disk.get(key);
    return { key, bytes: read.bytes, contentType: read.object.contentType };
  } catch (error) {
    if (isCode(error, 'X_STORAGE_NOT_FOUND') || isCode(error, 'X_STORAGE_TOO_LARGE')) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Delete `doomed`, a chunk at a time, then read the manifests and put back what any manifest
 * `counts` names. Correct against a publisher that writes its manifest and THEN ensures its files:
 * a manifest written before the fence read is seen there; one written after it is followed by that
 * publisher's own ensure, which runs after these deletes and puts the file back itself. A manifest
 * that does not parse names nothing knowable, so the chunk is put back whole. Returns the deleted.
 */
export async function deleteFenced(
  scope: RetainedScope,
  doomed: readonly string[],
  counts: (one: StoredManifest) => boolean,
): Promise<number> {
  let deleted = 0;
  for (let at = 0; at < doomed.length; at += FENCE_CHUNK) {
    const held: Held[] = [];
    await inBatches(doomed.slice(at, at + FENCE_CHUNK), async (key) => {
      const one = await hold(scope, key);
      if (one !== undefined) held.push(one);
    });
    await inBatches(held, ({ key }) => scope.disk.delete(key));
    const fence = await readManifests(scope);
    const named =
      fence === undefined
        ? undefined
        : new Set(
            fence
              .filter(counts)
              .flatMap(({ manifest }) => manifest.urls)
              .map((url) => retainedFileKey(scope.prefix, url)),
          );
    const back = held.filter(({ key }) => named === undefined || named.has(key));
    await inBatches(back, async ({ key, bytes, contentType }) => {
      await scope.disk.put(key, bytes, { contentType });
    });
    deleted += held.length - back.length;
  }
  return deleted;
}

/**
 * Delete a dropped manifest only if it still holds the date it was dropped at, read just before
 * the delete: a rollback re-dates it, and then it is the newest build, not this sweep's to drop.
 * The read and the delete are two calls, so a re-date landing between them is still lost — the
 * disk offers no delete conditional on a revision; that build's next pod re-publishes it.
 */
export async function deleteManifestIfUnchanged(
  scope: RetainedScope,
  key: string,
  publishedAt: number,
): Promise<void> {
  let bytes: Uint8Array;
  try {
    bytes = (await scope.disk.get(key)).bytes;
  } catch (error) {
    if (isCode(error, 'X_STORAGE_NOT_FOUND')) return;
    throw error;
  }
  let now: unknown;
  try {
    now = (JSON.parse(new TextDecoder().decode(bytes)) as { publishedAt?: unknown }).publishedAt;
  } catch {
    // Unparseable now: not the manifest judged, so not this sweep's to delete.
    return;
  }
  if (now === publishedAt) await scope.disk.delete(key);
}
