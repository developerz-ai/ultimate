import { action, t } from '@ultimat3/action';
import { AvatarUploadGrant } from '../entity';
import { memberSelf } from '../policy';

/**
 * The upload half of an avatar, and an `action` rather than a `route` because nothing but JSON
 * crosses here: the bytes go straight from the browser to the disk through the URL this mints.
 * No `orgId` in the input — the key is built from the ACTOR's org, and a tenant read off the
 * request is exactly the bypass `grantUpload` exists to prevent.
 *
 * Not an MCP tool. A presigned PUT is a capability, and an agent that cannot hold the bytes has
 * no use for one.
 */
export const grantAvatarUpload = action({
  input: t.object({
    /** Used for its extension and nothing else — the stored name is opaque. */
    filename: t.string.max(255),
    contentType: t.string.max(255),
    /** The client's own count, trusted for nothing: it only buys an early refusal. */
    size: t.number.int().min(0).optional(),
  }),
  output: AvatarUploadGrant,
  policy: memberSelf,
  async handle({ input, ctx }) {
    return ctx.orgs.grantAvatarUpload(input);
  },
});
