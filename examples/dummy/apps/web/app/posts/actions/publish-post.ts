// `publishPost`, the posts slice's action — one primitive per file, the layout `x g` writes.
//
// The posts feature's commands. Declarations only — every body delegates to `ctx.posts`, so the
// same logic runs whether the caller is HTTP, the typed client, a job, an MCP tool or admin.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
// `llm`, `agent` and `hive` are the other framework imports here, and none is a second primitive:
// each is a factory that RETURNS an `action`, so `summarize`, `reviewDraft` and `summarizePosts`
// belong in this file for the same reason the rest do — see `docs/idea/09-ai-first.md`.

import { tag } from '@postly/db';
import { postId } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import { PostView } from '../entity';
import { notifySubscribers } from '../jobs/notify-subscribers';
import { postPublish } from '../policy';

export const publishPost = action({
  input: t.object({ postId: t.uuid, orgId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: postPublish,
  // `postPublish` decides about a post, not just about an org, so the post has to be loaded
  // before the guard rather than inside it — the predicate stays synchronous, and this runs once
  // per invocation instead of once per live subscriber.
  //
  // The loader runs BEFORE any policy, which is the ordering that decides the scope: the service
  // reads inside the ACTING member's org and answers `null` for anyone without one, so a foreign
  // caller reaches the rule with `row: null` and is denied. Scoping it to `input.orgId` instead
  // put a tenancy error (`X_TENANCY_ACTOR_MISMATCH`, or `X_TENANCY_ACTOR_ORG_REQUIRED` for an
  // anonymous caller) in front of the denial — an unscoped read is `X_TENANCY_UNSCOPED`, and
  // neither is the `X_FORBIDDEN` this action's contract promises.
  row: ({ input: { postId: id }, ctx }) => ctx.posts.authorship(postId(id)),
  // `blog` too: publishing is the ONE write that puts a post on the public, anonymous blog, and
  // `site/blog/*` sets `revalidate: { tags: [tag.blog] }`. Omitting it left those ISR pages
  // pinned to whatever the build saw — the tag existed, nothing ever evicted it.
  cache: { invalidates: [tag.post, tag.feed, tag.blog] },
  mcp: { expose: true, description: 'Publish a draft post' },
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(postId(input.postId));
    // The job enqueues itself through its own handle, in the same transaction as the publish: a
    // rolled-back publish never mails anybody and a committed one always does.
    // The org the policy already decided on, carried into the payload: the fanout's reads are
    // tenant-scoped and a job has no request behind it to derive one from.
    if (input.notify) await notifySubscribers.enqueue({ postId: post.id, orgId: input.orgId });
    // The org's webhook receivers hear it too: one delivery per endpoint, in this same transaction.
    await ctx.webhooks.announcePublished(post);
    return post;
  },
});
