import { action, t } from '@ultimat3/action';
import { AvatarAttached } from '../entity';
import { memberSelf } from '../policy';

/**
 * The second half of an avatar upload: the bytes `grantAvatarUpload`'s URL put under `pending/`
 * become the acting member's avatar. Every check is the framework's — the key must be a pending
 * key in the ACTOR's org, sniffed, measured and passed by the installed `uploadScanner` — and a
 * held upload answers `X_STORAGE_QUARANTINED` until the scanner clears it; send the same key again.
 *
 * Not an MCP tool, for `grantAvatarUpload`'s reason: an agent cannot hold the bytes it would attach.
 */
export const attachAvatar = action({
  input: t.object({ key: t.string.max(512) }),
  output: AvatarAttached,
  policy: memberSelf,
  async handle({ input, ctx }) {
    return ctx.orgs.attachAvatar(input.key);
  },
});
