/**
 * The posts feature's commands. Declarations only — every body delegates to `ctx.posts`, so the
 * same logic runs whether the caller is HTTP, the typed client, a job, an MCP tool or admin.
 *
 * `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
 */

import { COMMENT_MAX, tag } from '@postly/db';
import { postId } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import { CommentView, CreatePostInput, PostView } from './entity';
import { notifySubscribers } from './jobs';
import { postCreate, postPublish, postRead } from './policy';

export const createPost = action({
  // orgId is part of the input because the policy decides on it — authz reads the declaration,
  // never the database. A predicate that fetched a row would cost one query per live subscriber.
  input: CreatePostInput.extend({ orgId: t.uuid }),
  output: PostView,
  policy: postCreate,
  cache: { invalidates: [tag.feed] },
  mcp: { expose: true, description: 'Create a draft post in the actor’s organisation' },
  async handle({ input, ctx }) {
    return ctx.posts.createDraft(input);
  },
});

export const publishPost = action({
  input: t.object({ postId: t.uuid, orgId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: postPublish,
  cache: { invalidates: [tag.post, tag.feed] },
  mcp: { expose: true, description: 'Publish a draft post' },
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(postId(input.postId));
    // The job enqueues itself through its own handle, in the same transaction as the publish: a
    // rolled-back publish never mails anybody and a committed one always does.
    if (input.notify) await notifySubscribers.enqueue({ postId: post.id });
    return post;
  },
});

export const createComment = action({
  input: t.object({ postId: t.uuid, orgId: t.uuid, body: t.string.min(1).max(COMMENT_MAX) }),
  output: CommentView,
  policy: postRead,
  cache: { invalidates: [tag.comment, tag.post] },
  mcp: { expose: true, description: 'Comment on a post the actor can read' },
  async handle({ input, ctx }) {
    return ctx.posts.comment(postId(input.postId), input.body);
  },
});
