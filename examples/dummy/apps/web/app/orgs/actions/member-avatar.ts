import { action, t } from '@ultimat3/action';
import { AvatarView } from '../entity';
import { memberSelf } from '../policy';

/**
 * The read half. An `action` and not a `query` for the same reason it takes no cache tag: every
 * call mints a fresh capability that expires, so a cached answer is a URL that has already died —
 * or worse, one actor's capability served to another.
 *
 * No `mcp` block, deliberately: the answer is a signed GET, which is a bearer capability — anyone
 * holding the string reads the bytes until it expires. A browser drops it on the next render; a
 * tool call copies it into a transcript that outlives it, for a picture no agent can look at.
 * `grantAvatarUpload` is closed to agents for the same reason, one exposure lower.
 */
export const memberAvatar = action({
  input: t.object({}),
  output: AvatarView,
  policy: memberSelf,
  async handle({ ctx }) {
    return { url: await ctx.orgs.avatarUrl() };
  },
});
