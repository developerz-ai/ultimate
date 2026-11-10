// Single responsibility: where an entity's files live, and how one that was never attached is
// found again. The upload happens BEFORE the row it belongs to exists, so it lands under a
// `pending/` segment inside the org and is promoted once there is an id — which makes an orphan
// a fact about the key rather than a join nobody runs. Every key here goes through `scopedKey`,
// so the tenant prefix is a construction, not a check somebody remembered to write.

import type { Clock } from '@ultimat3/core';
import { assert, finiteCount, nanoid, renderThrowable, systemClock } from '@ultimat3/core';
import type { StorageDriver, StorageListEntry, StorageObject } from './driver';
import { objectNotFound, orgMismatch, tooLarge } from './errors';
import { alreadyPromoted, notPending, objectChanged } from './errors-promote';
import { assertSafeKey, isWithinOrg, orgPrefix, scopedKey } from './path';
import type { UploadPolicy } from './upload';
import { SNIFF_WINDOW_BYTES, validateStoredHead } from './upload';
import { SCAN_SEGMENT, scanAttempt, scanning } from './upload-scan';

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
  /**
   * The policy the upload was GRANTED under — required, never defaulted. A URL an app signed itself
   * may carry no size, so `policy.maxBytes` binds nothing until this call measures the object; a
   * default here would silently replace an app's own ceiling with the framework's.
   */
  readonly policy: UploadPolicy;
}

/** The head window of one stored object, under the type it is stored as. */
async function judge(
  disk: StorageDriver,
  object: StorageObject,
  key: string,
  policy: UploadPolicy,
): Promise<void> {
  const head =
    object.size === 0
      ? new Uint8Array()
      : (await disk.get(key, { range: [0, SNIFF_WINDOW_BYTES - 1] })).bytes;
  validateStoredHead(
    { key, declaredContentType: object.contentType, head, size: object.size },
    policy,
  );
}

/**
 * `ifMatch` is the first line and this the second, for a disk whose `copy` honours no condition.
 * The upload URL stays valid after the sniff, so a copy is only trusted once it is known to be the
 * revision judged. Another size is another object, whatever else agrees.
 *
 * An etag alone does not settle it either way. An empty one says nothing, and an SSE-KMS or SSE-C
 * bucket mints a new etag per copy, so refusing on a difference would refuse every promotion there.
 * So a copy that cannot be proved the same is judged itself, by the rule the source just passed:
 * what lands on the row's key has been looked at either way. A refusal leaves nothing attached; a
 * delete that fails raises its own code, because the bytes are still there.
 */
async function assertCopyIsWhatWasJudged(
  disk: StorageDriver,
  judged: StorageObject,
  copy: StorageObject,
  policy: UploadPolicy,
): Promise<void> {
  const proved =
    judged.etag !== '' && copy.etag === judged.etag && copy.contentType === judged.contentType;
  if (proved && copy.size === judged.size) return;
  try {
    if (copy.size !== judged.size) {
      throw objectChanged(copy.key, `${judged.size}B`, `${copy.size}B`);
    }
    await judge(disk, copy, copy.key, policy);
  } catch (error) {
    await disk.delete(copy.key);
    throw error;
  }
}

/**
 * Move a pending upload onto the row that now exists. Copy first, delete second: a delete that
 * ran first would lose the bytes on a failed write, and the sweep would have collected them
 * anyway.
 *
 * MEASURED before it moves: `stat().size` over `policy.maxBytes` is `X_STORAGE_TOO_LARGE`, and the
 * object stays under `pending/` for `sweepOrphans` — never at a key a row points to. `stat` and
 * not `get`: this is the call that learns the size, so it cannot be one that buffers it.
 *
 * SNIFFED before it moves, off a head window. A provider's presigned PUT binds method, expiry and at
 * most a size, so a bucket holds whatever bytes and whatever type the uploader sent, and this is the first
 * code that looks: bytes that contradict the stored type are `X_STORAGE_TYPE_REJECTED`, and stay
 * pending too. A ranged read because `maxGetBytes` bounds the range, never the object. An overwrite
 * after that read is `X_STORAGE_OBJECT_CHANGED`, or the copy itself is judged, and never lands.
 *
 * SCANNED before it attaches, when `runtime.ts` installs an `uploadScanner`: on a per-attempt copy
 * no presigned URL can rewrite (`scannedAttempt`), which is then what is attached. Infected is
 * `X_STORAGE_UPLOAD_INFECTED` with attempt and upload deleted; no verdict is
 * `X_STORAGE_SCAN_UNAVAILABLE` with the attempt deleted and the upload still pending, unless
 * `policy.onScanUnavailable` accepts; a `hold` verdict (a review, an async vendor scan) is
 * `X_STORAGE_QUARANTINED`, the upload pending, and no policy overrides it. None ever touches the
 * row's key. This is the ONE scan path: the v30 `quarantine: true` segment is retired.
 *
 * A source that is gone with the destination already there is `X_STORAGE_ALREADY_PROMOTED`
 * (409, `meta.attachedKey`), never the destination answered as if this call had moved it. 27.1.0
 * answered it: a confirm sent twice then inserted a second row for one key, that insert failed,
 * and its cleanup deleted the FIRST row's bytes. Only the call that moved the bytes may hand them
 * back; a retry is told where they are and answers the row that holds them. A source that is gone
 * with NO destination is still `X_STORAGE_NOT_FOUND`.
 *
 * The copy is `disk.copy`, not `get` + `put`: promotion used to download the whole object into
 * this process and upload it again, so attaching a 500MB file moved a gigabyte through the pod
 * for a rename. `copy` never touches the app's heap on either driver.
 */
export async function promoteAttachment(input: PromoteAttachmentInput): Promise<StorageObject> {
  if (!isWithinOrg(input.key, input.orgId)) throw orgMismatch(input.key, input.orgId);
  // Pending, not merely in-org: an attached key a client sent back belongs to another row, and the
  // copy-then-delete below would move that row's file here and delete theirs.
  if (!isPendingKey(input.key, input.orgId)) throw notPending(input.key, input.orgId);
  // The type says required; an untyped caller upgrading from the four-field call does not read
  // types, and `input.policy.maxBytes` on `undefined` is a bare `TypeError` two lines down.
  assert(
    typeof input.policy?.maxBytes === 'number',
    'promoteAttachment was called with no policy, so nothing bounds the size of the upload it attaches',
    'promoteAttachment({ disk, key, orgId, target, policy: uploadPolicy({ maxBytes }) }) — the policy the upload was granted under',
  );
  const disk = input.disk;
  const name = input.key.slice(input.key.lastIndexOf('/') + 1);
  const attached = attachmentKey(input.orgId, input.target, name);
  const pending = await disk.stat(input.key);
  if (pending === undefined) {
    if ((await disk.stat(attached)) !== undefined) {
      throw alreadyPromoted(input.key, attached, input.orgId);
    }
    throw objectNotFound(disk.name, input.key);
  }
  if (pending.size > input.policy.maxBytes) {
    throw tooLarge(input.key, pending.size, input.policy.maxBytes);
  }
  await judge(disk, pending, input.key, input.policy);
  const scanned = scanning() ? await scannedAttempt(disk, pending, input, name) : undefined;
  const source = scanned ?? pending;
  const object = await disk.copy(
    scanned?.key ?? input.key,
    attached,
    source.etag === '' ? undefined : { ifMatch: source.etag },
  );
  await assertCopyIsWhatWasJudged(disk, source, object, input.policy);
  // The attempt is this call's scratch: a delete that fails leaves an orphan the sweep collects,
  // never a refusal of a promotion that already happened.
  if (scanned !== undefined) await disk.delete(scanned.key).catch(() => undefined);
  await disk.delete(input.key);
  return object;
}

/**
 * With an `uploadScanner` installed, what is attached is a copy THIS call made and scanned: under
 * `pending/scan/`, server-named (no presigned URL rewrites it after the scan) and its own (a
 * refusal deletes it and nothing a doubled confirm attached). Judged like any copy first.
 */
async function scannedAttempt(
  disk: StorageDriver,
  pending: StorageObject,
  input: PromoteAttachmentInput,
  name: string,
): Promise<StorageObject> {
  const key = scopedKey(input.orgId, PENDING_SEGMENT, SCAN_SEGMENT, `${nanoid()}-${name}`);
  const attempt = await disk.copy(
    input.key,
    key,
    pending.etag === '' ? undefined : { ifMatch: pending.etag },
  );
  await assertCopyIsWhatWasJudged(disk, pending, attempt, input.policy);
  await scanAttempt({ disk, pendingKey: input.key, attempt, policy: input.policy });
  return attempt;
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
 * Scoped to one org and to the `pending/` prefix — a `hold` included, since a held upload is still
 * pending: a sweep that could reach an attached key is a job that deletes production data
 * the first time an app forgets to promote something.
 *
 * A refusal is recorded and the sweep continues. Stopping at the first one would leave the caller
 * unable to distinguish "one key is stuck" from "this whole disk denies deletes", and a caller
 * with `failed` non-empty already knows not to report the batch as erased.
 */
export async function sweepOrphans(input: SweepOrphansInput): Promise<SweepResult> {
  const clock = input.clock ?? systemClock;
  // Screened first: `now - NaN` is NaN and `lastModified > NaN` is false — the "old enough"
  // answer — so `olderThanMs: NaN` deleted an upload created a moment ago.
  const olderThanMs = finiteCount('sweepOrphans', 'olderThanMs', input.olderThanMs, 0);
  const cutoff = clock.now().getTime() - olderThanMs;
  const prefix = pendingPrefix(input.orgId);
  const deleted: string[] = [];
  const failed: SweepFailure[] = [];
  let cursor: string | null = null;
  do {
    const page = await input.disk.list({ prefix, cursor });
    for (const object of page.rows) {
      // An object whose age the provider did not report is SPARED: only a proven age is swept.
      if (object.lastModified === undefined || object.lastModified.getTime() > cutoff) continue;
      if ((await input.keep?.(object)) === true) continue;
      try {
        await input.disk.delete(object.key);
        deleted.push(object.key);
      } catch (error) {
        failed.push({ key: object.key, reason: renderThrowable(error) });
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { deleted, failed };
}

export interface DeleteVariantsInput {
  readonly disk: StorageDriver;
  /** The SOURCE key. Its variants are every key that opens with it and `@`. */
  readonly key: string;
}

/**
 * Delete every stored variant of one source, of every revision, and answer as `sweepOrphans` does:
 * a refusal is recorded and the walk continues, so an erasure never reports what is still there.
 * The source itself is the caller's to delete. `@` is in the prefix, so `x.png2@w1.webp` is
 * another source's variant and stays.
 */
export async function deleteVariants(input: DeleteVariantsInput): Promise<SweepResult> {
  const prefix = `${assertSafeKey(input.key)}@`;
  const deleted: string[] = [];
  const failed: SweepFailure[] = [];
  let cursor: string | null = null;
  do {
    const page = await input.disk.list({ prefix, cursor });
    for (const object of page.rows) {
      try {
        await input.disk.delete(object.key);
        deleted.push(object.key);
      } catch (error) {
        failed.push({ key: object.key, reason: renderThrowable(error) });
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { deleted, failed };
}
