// Single responsibility: where an entity's files live, and how one that was never attached is
// found again. The upload happens BEFORE the row it belongs to exists, so it lands under a
// `pending/` segment inside the org and is promoted once there is an id — which makes an orphan
// a fact about the key rather than a join nobody runs. Every key here goes through `scopedKey`,
// so the tenant prefix is a construction, not a check somebody remembered to write.

import type { Clock } from '@ultimat3/core';
import { systemClock } from '@ultimat3/core';
import type { ListPage, StorageDriver, StorageObject } from './driver';
import { orgMismatch } from './errors';
import { isWithinOrg, orgPrefix, scopedKey } from './path';

/** The one segment an unattached upload lives under. `sweepOrphans` reads only this prefix. */
export const PENDING_SEGMENT = 'pending';

export interface AttachmentTarget {
  /** Entity name as the app declares it — `post`, `user`. Exactly one key segment. */
  readonly entity: string;
  readonly id: string;
  /** The field on that entity the file belongs to — `avatar`, `attachments`. */
  readonly field: string;
}

// Deliberately narrow. A filename is client-supplied, and an extension is decoration: the stored
// content type is the SNIFFED one (`validateUpload`), so anything longer or stranger is dropped
// rather than sanitised — sanitising is what turns `evil.png.html` into a key that looks safe.
const EXTENSION = /^\.[a-z0-9]{1,12}$/;

export function uploadExtension(filename: string): string {
  const cut = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const base = filename.slice(cut + 1);
  const dot = base.lastIndexOf('.');
  const extension = dot <= 0 ? '' : base.slice(dot).toLowerCase();
  return EXTENSION.test(extension) ? extension : '';
}

/**
 * The final key segment: an opaque id plus the surviving extension. The id — never the client's
 * filename — is what makes the key unguessable and collision-free; the original name belongs in
 * the entity row, where it can be displayed without ever being a path.
 */
export function uploadName(uploadId: string, filename: string): string {
  return `${uploadId}${uploadExtension(filename)}`;
}

/** `org/<orgId>/pending/<name>` — an upload with no row behind it yet. */
export function pendingKey(orgId: string, name: string): string {
  return scopedKey(orgId, PENDING_SEGMENT, name);
}

export function pendingPrefix(orgId: string): string {
  return `${orgPrefix(orgId)}${PENDING_SEGMENT}/`;
}

/** `org/<orgId>/<entity>/<id>/<field>/` — every file one field of one row owns. */
export function attachmentPrefix(orgId: string, target: AttachmentTarget): string {
  return `${scopedKey(orgId, target.entity, target.id, target.field)}/`;
}

export function attachmentKey(orgId: string, target: AttachmentTarget, name: string): string {
  return scopedKey(orgId, target.entity, target.id, target.field, name);
}

export const isPendingKey = (key: string, orgId: string): boolean =>
  key.startsWith(pendingPrefix(orgId));

export interface PromoteAttachmentInput {
  readonly disk: StorageDriver;
  /** A key `grantUpload` minted with no `target`. */
  readonly key: string;
  readonly orgId: string;
  readonly target: AttachmentTarget;
}

/**
 * Move a pending upload onto the row that now exists. Copy first, delete second: a delete that
 * ran first would lose the bytes on a failed write, and the sweep would have collected them
 * anyway. Re-promoting an already-promoted key is `X_STORAGE_NOT_FOUND` from the read, never a
 * silent no-op that leaves the caller believing a file is attached.
 */
export async function promoteAttachment(input: PromoteAttachmentInput): Promise<StorageObject> {
  if (!isWithinOrg(input.key, input.orgId)) throw orgMismatch(input.key, input.orgId);
  const read = await input.disk.get(input.key);
  const name = input.key.slice(input.key.lastIndexOf('/') + 1);
  const attached = attachmentKey(input.orgId, input.target, name);
  const object = await input.disk.put(attached, read.bytes, {
    contentType: read.object.contentType,
  });
  await input.disk.delete(input.key);
  return object;
}

export interface SweepOrphansInput {
  readonly disk: StorageDriver;
  readonly orgId: string;
  /** Age past which an unattached upload is an orphan. Longer than any form can stay open. */
  readonly olderThanMs: number;
  readonly clock?: Clock | undefined;
  /**
   * Return `true` to spare a key the app can still account for. Absent spares nothing, because
   * a pending key by definition has no row pointing at it — override only when the app parks
   * a reference somewhere the prefix cannot express.
   */
  readonly keep?: ((object: StorageObject) => boolean | Promise<boolean>) | undefined;
}

/**
 * Delete every unattached upload past the window, and answer with the keys that went. Scoped to
 * one org and to the `pending/` prefix: a sweep that could reach an attached key is a job that
 * deletes production data the first time an app forgets to promote something.
 */
export async function sweepOrphans(input: SweepOrphansInput): Promise<readonly string[]> {
  const clock = input.clock ?? systemClock;
  const cutoff = clock.now().getTime() - input.olderThanMs;
  const prefix = pendingPrefix(input.orgId);
  const deleted: string[] = [];
  let cursor: string | undefined;
  do {
    const page: ListPage = await input.disk.list({
      prefix,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of page.objects) {
      if (object.lastModified.getTime() > cutoff) continue;
      if ((await input.keep?.(object)) === true) continue;
      await input.disk.delete(object.key);
      deleted.push(object.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return deleted;
}
