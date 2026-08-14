/**
 * Where a member's avatar lives, and the two capabilities Postly hands a browser for it: a
 * presigned PUT to upload one, and a short-lived signed GET to render it.
 *
 * Every key is `@ultimat3/storage`'s construction, never this file's string arithmetic —
 * `grantUpload` derives `org/<orgId>/member/<memberId>/avatar/<opaque><ext>` from the org the
 * SERVER resolved, so the client names no key and cannot aim an upload at another tenant.
 *
 * Nothing is created before the first upload, and that is the whole answer to "provision the
 * org's storage": a disk is declared in `app.config.ts` and built once at boot, and the tenant
 * boundary is that key prefix — not a bucket per org, which no driver here can make.
 */

import type { MemberId, OrgId } from '@postly/domain';
import type { Clock } from '@ultimat3/core';
import type {
  AttachmentTarget,
  StorageObject,
  UploadGrant,
  UploadRequest,
} from '@ultimat3/storage';
import { attachmentPrefix, disk, grantUpload, uploadPolicy } from '@ultimat3/storage';

/** Singular: the segment names one row's field, the way `attachmentKey` composes it. */
const AVATAR_ENTITY = 'member';
const AVATAR_FIELD = 'avatar';

/**
 * Images only, and no SVG — an SVG is a script the moment a surface serves it back inline, and
 * an avatar is served back to everyone in the org. 2 MB because an avatar renders at 96px:
 * anything larger is a photo nobody asked to store.
 */
export const avatarUploadPolicy = uploadPolicy({
  maxBytes: 2 * 1024 * 1024,
  allowedContentTypes: ['image/png', 'image/jpeg', 'image/webp'],
});

/** Short: the URL is a capability, not a CDN address, and it is minted per render. */
export const AVATAR_URL_TTL_MS = 5 * 60_000;

export const avatarTarget = (memberId: MemberId): AttachmentTarget => ({
  entity: AVATAR_ENTITY,
  id: memberId,
  field: AVATAR_FIELD,
});

export interface AvatarGrantInput {
  /** The ACTOR's org, resolved server-side: an orgId read off the request is a tenant bypass. */
  readonly orgId: OrgId;
  readonly memberId: MemberId;
  readonly request: UploadRequest;
  readonly clock: Clock;
}

/**
 * Mint the presigned PUT. `grantUpload` refuses before it signs, so a disallowed type or an
 * over-limit size costs one round trip instead of a full transfer, and both constraints then
 * ride inside the signature where the client cannot widen them.
 *
 * The browser half is the framework's, handed this action's own typed client:
 * `uploadFile({ file, grant: client.grantAvatarUpload })` from `@ultimat3/storage`. Against an S3
 * disk that PUT lands in the bucket with no server of ours in the path; against the embedded dev
 * disk it needs a host that mounts `acceptSignedUpload`, and `x dev` serves the read half
 * (`GET /_storage/:disk/*key`) only.
 */
export const mintAvatarGrant = (input: AvatarGrantInput): Promise<UploadGrant> =>
  grantUpload({
    disk: disk(),
    orgId: input.orgId,
    request: input.request,
    policy: avatarUploadPolicy,
    // The member row already exists, so the bytes land on the row rather than under `pending/`:
    // no promotion step, and nothing for `sweepOrphans` to collect.
    target: avatarTarget(input.memberId),
    clock: input.clock,
  });

/**
 * Last upload wins. `lastModified` is the disk's own — the local driver reports the file's mtime,
 * so two uploads inside one millisecond tie and the key breaks it: arbitrary, but never
 * ambiguous. Earlier uploads stay on the disk; reclaiming them needs the key on the member row,
 * a column this app deliberately does not have, so the prefix is the record and this picks.
 */
const newest = (objects: readonly StorageObject[]): StorageObject | undefined =>
  objects.reduce<StorageObject | undefined>((best, object) => {
    if (best === undefined) return object;
    const delta = object.lastModified.getTime() - best.lastModified.getTime();
    return delta > 0 || (delta === 0 && object.key > best.key) ? object : best;
  }, undefined);

/** A signed GET for the member's current avatar, or `null` before they have uploaded one. */
export async function signedAvatarUrl(orgId: OrgId, memberId: MemberId): Promise<string | null> {
  const driver = disk();
  const page = await driver.list({ prefix: attachmentPrefix(orgId, avatarTarget(memberId)) });
  const current = newest(page.objects);
  if (current === undefined) return null;
  return driver.signedUrl(current.key, { method: 'GET', expiresInMs: AVATAR_URL_TTL_MS });
}
