/**
 * The posts feature's commands. Declarations only — every body delegates to `ctx.posts`, so the
 * same logic runs whether the caller is HTTP, the typed client, a job, an MCP tool or admin.
 */

import { COMMENT_MAX, tag } from '@postly/db';
import { action } from '@ultimat3/action';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { CommentView, CreatePostInput, PostView } from './entity';
import { notifySubscribers } from './jobs';
import { ownsPost } from './policy';

export const createPost = action({
  input: CreatePostInput,
  output: PostView,
  policy: can('post:create'),
  cache: { invalidates: [tag.feed] },
  mcp: { expose: true, description: 'Create a draft post in the actor’s organisation' },
  async handle({ input, ctx }) {
    return ctx.posts.createDraft(input);
  },
});

export const publishPost = action({
  input: t.object({ postId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId)),
  cache: { invalidates: [tag.post, tag.feed] },
  mcp: { expose: true, description: 'Publish a draft post' },
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(input.postId);
    if (input.notify) await ctx.jobs.enqueue(notifySubscribers, { postId: post.id });
    return post;
  },
});

export const createComment = action({
  input: t.object({ postId: t.uuid, body: t.string.atLeastLength(1).atMostLength(COMMENT_MAX) }),
  output: CommentView,
  policy: can('post:read'),
  cache: { invalidates: [tag.comment, tag.post] },
  mcp: { expose: true, description: 'Comment on a post the actor can read' },
  async handle({ input, ctx }) {
    return ctx.posts.comment(input.postId, input.body);
  },
});
