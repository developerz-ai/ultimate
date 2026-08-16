/**
 * Org commands. `inviteMember` is where the seat limit bites; `upgradePlan` is where money is
 * handled — in integer minor units, quoted by `@postly/core`, formatted by nobody here.
 *
 * `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
 */

import { tag } from '@postly/db';
import { memberId, PLAN_CODES } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import { AvatarUploadGrant, AvatarView, InviteInput, MemberView, UpgradeReceipt } from './entity';
import { sendInvite } from './jobs';
import { memberSelf, orgAdminister, orgInvite } from './policy';

export const inviteMember = action({
  // orgId rides in the input because `orgInvite` decides on it — the rule reads the declaration,
  // never the database.
  input: InviteInput.extend({ orgId: t.uuid }),
  output: MemberView,
  policy: orgInvite,
  cache: { invalidates: [tag.member, tag.org] },
  mcp: { expose: true, description: 'Invite a person to the actor’s organisation' },
  async handle({ input, ctx }) {
    const member = await ctx.orgs.invite(input);
    // The job enqueues itself, in the same transaction as the insert: a rolled-back invite never
    // mails anyone.
    // The org comes off the row that was just written, never off the input: `ctx.orgs.invite`
    // seats the member in the ACTOR's org, and that is the tenant the job has to run as.
    await sendInvite.enqueue({ memberId: memberId(member.id), orgId: member.orgId });
    return member;
  },
});

export const upgradePlan = action({
  input: t.object({ orgId: t.uuid, plan: t.enumerated(...PLAN_CODES) }),
  output: UpgradeReceipt,
  policy: orgAdminister,
  cache: { invalidates: [tag.org, tag.plan] },
  mcp: {
    expose: true,
    description: 'Move the organisation to a higher plan and return the prorated receipt',
  },
  async handle({ input, ctx }) {
    return ctx.orgs.upgrade(input.plan);
  },
});

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
