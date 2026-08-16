// Single responsibility: where an entity's files live, and how one that was never attached is
// found again. The upload happens BEFORE the row it belongs to exists, so it lands under a
// `pending/` segment inside the org and is promoted once there is an id — which makes an orphan
// a fact about the key rather than a join nobody runs. Every key here goes through `scopedKey`,
// so the tenant prefix is a construction, not a check somebody remembered to write.

import type { Clock } from '@ultimat3/core';
import { renderThrowable, systemClock } from '@ultimat3/core';
import type { ListPage, StorageDriver, StorageListEntry, StorageObject } from './driver';
import { orgMismatch, quarantined } from './errors';
import { isWithinOrg, orgPrefix, scopedKey } from './path';

/** The one segment an unattached upload lives under. `sweepOrphans` reads only this prefix. */
export const PENDING_SEGMENT = 'pending';

/**
 * One more segment inside `pending/`, and the whole of Ultimate's content-scanning mechanism.
 *
 * Magic-byte sniffing closes stored XSS; it is not malware scanning, and `application/zip` is
 * deliberately accepted as the OOXML container, so a macro-laden `.docx` passes `validateUpload`
 * exactly as a clean one does. Scanning is the APP's — a scanner is a business decision with a
 * vendor, a licence and a latency budget (axiom 8) — so what ships is the place to put one: an
 * upload granted with `quarantine: true` lands under this prefix, `promoteAttachment` REFUSES a
 * key that is still there (`X_STORAGE_QUARANTINED`), and the app's scan job calls
 * `releaseQuarantine` on a verdict of clean. Inside `pending/` on purpose: an upload nobody ever
 * scanned is still an orphan, so `sweepOrphans` collects it with no second prefix to walk.
 */
export const QUARANTINE_SEGMENT = 'quarantine';

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

/** `org/<orgId>/pending/quarantine/<name>` — uploaded, validated, and not yet cleared to use. */
export function quarantineKey(orgId: string, name: string): string {
  return scopedKey(orgId, PENDING_SEGMENT, QUARANTINE_SEGMENT, name);
}

export function quarantinePrefix(orgId: string): string {
  return `${pendingPrefix(orgId)}${QUARANTINE_SEGMENT}/`;
}

export const isPendingKey = (key: string, orgId: string): boolean =>
  key.startsWith(pendingPrefix(orgId));

/** True while nothing has cleared the key. `promoteAttachment` refuses exactly this. */
export const isQuarantinedKey = (key: string, orgId: string): boolean =>
  key.startsWith(quarantinePrefix(orgId));

export interface ReleaseQuarantineInput {
  readonly disk: StorageDriver;
  /** A key under `quarantinePrefix(orgId)`. */
  readonly key: string;
  readonly orgId: string;
}

/**
 * The app's scan said clean: move the object out of quarantine and onto the ordinary `pending/`
 * key, which `promoteAttachment` will accept. Copy then delete, for the reason promotion does —
 * a delete that ran first loses the bytes on a failed write.
 *
 * Releasing a key that is not quarantined returns it untouched rather than copying it onto
 * itself: a scan job that retries after a crash must not be a second round trip, and a `pending/`
 * key is already the released state.
 */
export async function releaseQuarantine(input: ReleaseQuarantineInput): Promise<string> {
  if (!isWithinOrg(input.key, input.orgId)) throw orgMismatch(input.key, input.orgId);
  if (!isQuarantinedKey(input.key, input.orgId)) return input.key;
  const name = input.key.slice(input.key.lastIndexOf('/') + 1);
  const released = pendingKey(input.orgId, name);
  await input.disk.copy(input.key, released);
  await input.disk.delete(input.key);
  return released;
}

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
 * anyway. Re-promoting an already-promoted key is `X_STORAGE_NOT_FOUND` from the copy, never a
 * silent no-op that leaves the caller believing a file is attached.
 *
 * The copy is `disk.copy`, not `get` + `put`: promotion used to download the whole object into
 * this process and upload it again, so attaching a 500MB file moved a gigabyte through the pod
 * for a rename. `copy` never touches the app's heap on either driver.
 */
export async function promoteAttachment(input: PromoteAttachmentInput): Promise<StorageObject> {
  if (!isWithinOrg(input.key, input.orgId)) throw orgMismatch(input.key, input.orgId);
  if (isQuarantinedKey(input.key, input.orgId)) throw quarantined(input.key, input.orgId);
  const name = input.key.slice(input.key.lastIndexOf('/') + 1);
  const attached = attachmentKey(input.orgId, input.target, name);
  const object = await input.disk.copy(input.key, attached);
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
  readonly keep?: ((object: StorageListEntry) => boolean | Promise<boolean>) | undefined;
}

/** One key the sweep tried to delete and could not, with the disk's own words for why. */
export interface SweepFailure {
  readonly key: string;
  readonly reason: string;
}

/**
 * Two lists, because one cannot be wrong. A sweep that answered a single array of "deleted" keys
 * put every refusal in it: a GDPR erasure over 200 objects against a bucket whose policy had lost
 * `s3:DeleteObject` returned all 200 as deleted, and the compliance report said the data was gone.
 */
export interface SweepResult {
  readonly deleted: readonly string[];
  readonly failed: readonly SweepFailure[];
}

/**
 * Delete every unattached upload past the window, and answer with what went and what did not.
 * Scoped to one org and to the `pending/` prefix — quarantine included, since it lives inside
 * that prefix: a sweep that could reach an attached key is a job that deletes production data
 * the first time an app forgets to promote something.
 *
 * A refusal is recorded and the sweep continues. Stopping at the first one would leave the caller
 * unable to distinguish "one key is stuck" from "this whole disk denies deletes", and a caller
 * with `failed` non-empty already knows not to report the batch as erased.
 */
export async function sweepOrphans(input: SweepOrphansInput): Promise<SweepResult> {
  const clock = input.clock ?? systemClock;
  const cutoff = clock.now().getTime() - input.olderThanMs;
  const prefix = pendingPrefix(input.orgId);
  const deleted: string[] = [];
  const failed: SweepFailure[] = [];
  let cursor: string | undefined;
  do {
    const page: ListPage = await input.disk.list({
      prefix,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of page.objects) {
      if (object.lastModified.getTime() > cutoff) continue;
      if ((await input.keep?.(object)) === true) continue;
      try {
        await input.disk.delete(object.key);
        deleted.push(object.key);
      } catch (error) {
        failed.push({ key: object.key, reason: renderThrowable(error) });
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return { deleted, failed };
}
