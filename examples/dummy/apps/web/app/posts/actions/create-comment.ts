// `createComment`, the posts slice's action — one primitive per file, the layout `x g` writes.
//
// The posts feature's commands. Declarations only — every body delegates to `ctx.posts`, so the
// same logic runs whether the caller is HTTP, the typed client, a job, an MCP tool or admin.
//
// `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
// `llm`, `agent` and `hive` are the other framework imports here, and none is a second primitive:
// each is a factory that RETURNS an `action`, so `summarize`, `reviewDraft` and `summarizePosts`
// belong in this file for the same reason the rest do — see `docs/idea/09-ai-first.md`.

import { COMMENT_MAX, tag } from '@postly/db';
import { postId } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import { CommentView } from '../entity';
import { commentPosted } from '../jobs/comment-posted';
import { postRead } from '../policy';

export const createComment = action({
  input: t.object({ postId: t.uuid, orgId: t.uuid, body: t.string.min(1).max(COMMENT_MAX) }),
  output: CommentView,
  policy: postRead,
  cache: { invalidates: [tag.comment, tag.post] },
  mcp: { expose: true, description: 'Comment on a post the actor can read' },
  async handle({ input, ctx }) {
    const comment = await ctx.posts.comment(postId(input.postId), input.body);
    // The author hears about it (`commentPosted`, a notifier — a job), enqueued in this request's
    // transaction: a rolled-back comment mails nobody. The two names ride in the payload because
    // the mail renders on a worker with no request to read them through.
    const [post, me] = await Promise.all([ctx.posts.byId(postId(input.postId)), ctx.orgs.me()]);
    await commentPosted.enqueue({
      params: {
        postId: post.id,
        orgId: input.orgId,
        commentId: comment.id,
        commenterId: me.id,
        title: post.title,
        commenter: me.name,
      },
    });
    return comment;
  },
});
