/**
 * Notifications the posts feature sends. `notifier()` is a job factory: a notification inherits the
 * queue's retry, dead letter and cancellation, plus what a hand-rolled fan-out job (`./jobs.ts`'s
 * `notifySubscribers`) writes by hand — one durable step per recipient and channel, a delivery
 * ledger that makes a replayed run send nothing twice, and a preference gate.
 *
 * `t` comes from @ultimat3/notify, not @ultimat3/schema: a notifier file imports one package.
 */

import { memberId as toMemberId, postId as toPostId } from '@postly/domain';
import { send } from '@ultimat3/mail';
import { mailChannel, notifier, t } from '@ultimat3/notify';
import { type CommentPostedData, commentPostedMail } from './mail';

/** What `createComment` enqueues: the ids the audience is resolved from, and the mail's two names. */
export interface CommentPosted extends CommentPostedData {
  readonly orgId: string;
  readonly commentId: string;
  readonly commenterId: string;
}

/**
 * The post's author hears about a comment on it — unless they wrote it. One event per comment
 * (`key`), so a retried `createComment` job is one mail, not two; the audience is read on the
 * worker, inside a durable step, so a replay does not re-read it.
 */
export const commentPosted = notifier({
  name: 'post.commented',
  input: t.object({
    postId: t.uuid,
    orgId: t.uuid,
    commentId: t.uuid,
    commenterId: t.uuid,
    title: t.string,
    commenter: t.string,
  }),
  tenant: (params) => params.orgId,
  key: (params) => `comment:${params.commentId}`,
  recipients: async ({ input, ctx }) => {
    const post = await ctx.posts.byId(toPostId(input.postId));
    if (post.authorId === input.commenterId) return [];
    const author = await ctx.orgs.memberById(toMemberId(post.authorId));
    return [{ id: author.id, to: author.email, locale: author.locale, tz: author.tz }];
  },
  deliver: [
    {
      channel: mailChannel<CommentPosted>({
        mailer: {
          send: async (mail) => {
            for (const { params } of mail.batch) {
              await send(
                commentPostedMail,
                { postId: params.postId, title: params.title, commenter: params.commenter },
                { to: mail.to, locale: mail.locale ?? 'en' },
              );
            }
          },
        },
      }),
    },
  ],
});
