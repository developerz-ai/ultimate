/**
 * The step that makes an upload a member's avatar: `promoteAttachment` moves it off `pending/`
 * (sniffed, measured and SCANNED — `apps/web/runtime.ts`'s `uploadScanner`), then every earlier
 * avatar of that member and their resized copies are deleted, so the prefix holds one avatar.
 *
 * Both halves run under one fleet-wide `withLock` per member. The prune keeps the avatar THIS call
 * attached, so two attaches of one member on two pods, unserialised, could each delete the
 * other's — leaving the member none. Nothing in Postgres can say it: the objects are on the disk.
 */

import type { MemberId, OrgId } from '@postly/domain';
import { withLock } from '@ultimat3/jobs';
import type { StorageObject } from '@ultimat3/storage';
import {
  attachmentPrefix,
  disk,
  isStorageError,
  promoteAttachment,
  variantSourceOf,
} from '@ultimat3/storage';
import { avatarTarget, avatarUploadPolicy } from './avatar';

/** The lock's key: one member's avatar prefix, whichever org-scoped key it lives under. */
export const avatarLockKey = (orgId: OrgId, memberId: MemberId): string =>
  `postly:avatar:${orgId}:${memberId}`;

/**
 * Held well past one promote of a 2 MB file plus one prefix listing; renewed while it runs, so a
 * slow disk keeps it. `wait` covers a double-click's second attach waiting out the first.
 */
const AVATAR_LOCK = { ttl: '30s', wait: '10s' } as const;

export interface AttachAvatarInput {
  readonly orgId: OrgId;
  readonly memberId: MemberId;
  /** The `pending/` key `grantAvatarUpload` answered. Anything else is refused by storage. */
  readonly key: string;
}

/** The kept key, and the variants of it, survive; every other object under the prefix goes. */
const keeps = (kept: string, key: string): boolean =>
  key === kept || variantSourceOf(key)?.source === kept;

async function pruneAvatars(input: AttachAvatarInput, kept: string, signal: AbortSignal) {
  const driver = disk();
  const prefix = attachmentPrefix(input.orgId, avatarTarget(input.memberId));
  const stale: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await driver.list({ prefix, cursor });
    stale.push(...page.rows.filter((row) => !keeps(kept, row.key)).map((row) => row.key));
    cursor = page.nextCursor;
  } while (cursor !== null);
  for (const key of stale) {
    // A lost lease aborts here: the next holder's prune is the one that decides, not this one.
    // The fencing token is unused, by acceptance: a disk has no conditional delete to carry it, so
    // a holder paused past the 30 s `ttl` between this check and the delete can still remove the
    // next holder's avatar. The member re-uploads; nothing else is lost.
    signal.throwIfAborted();
    await driver.delete(key);
  }
}

/**
 * The promoted object. A retry of an attach that promoted and then failed — the prune, the
 * `warmAvatar` enqueue, a lost lock — is `X_STORAGE_ALREADY_PROMOTED`; the bytes it names are
 * already the avatar, so the retry finishes the work instead of refusing it.
 */
async function promoted(input: AttachAvatarInput): Promise<StorageObject> {
  try {
    return await promoteAttachment({
      disk: disk(),
      key: input.key,
      orgId: input.orgId,
      target: avatarTarget(input.memberId),
      policy: avatarUploadPolicy,
    });
  } catch (error) {
    if (!isStorageError(error) || error.code !== 'X_STORAGE_ALREADY_PROMOTED') throw error;
    const attachedKey = error.meta?.['attachedKey'];
    const attached = typeof attachedKey === 'string' ? await disk().stat(attachedKey) : undefined;
    // Gone between storage's check and this stat (a later attach pruned it): the refusal stands.
    if (attached === undefined) throw error;
    return attached;
  }
}

/**
 * Promote, then prune, as the member's one holder fleet-wide. Every refusal is storage's and
 * coded: `X_STORAGE_UPLOAD_INFECTED`, `X_STORAGE_QUARANTINED` (held — the same call attaches it
 * once the scanner clears it), `X_STORAGE_TYPE_REJECTED`, `X_STORAGE_NOT_FOUND` (a retry whose avatar a later attach replaced); a busy
 * member past `wait` is `X_LOCK_NOT_ACQUIRED`.
 */
export const attachAvatar = (input: AttachAvatarInput): Promise<StorageObject> =>
  withLock(
    avatarLockKey(input.orgId, input.memberId),
    async ({ signal }) => {
      const attached = await promoted(input);
      await pruneAvatars(input, attached.key, signal);
      return attached;
    },
    AVATAR_LOCK,
  );
