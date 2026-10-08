/**
 * Notifications the posts feature sends. `notifier()` is a job factory: a notification inherits the
 * queue's retry, dead letter and cancellation, plus what a hand-rolled fan-out job (`./jobs.ts`'s
 * `notifySubscribers`) writes by hand — one durable step per recipient and channel, a delivery
 * ledger that makes a replayed run send nothing twice, and a preference gate.
 *
 * `t` comes from @ultimat3/notify, not @ultimat3/schema: a notifier file imports one package — and
 * the push transport from @ultimat3/pwa, because `pushChannel` takes it structurally.
 */

import { memberId as toMemberId, orgId as toOrgId, postId as toPostId } from '@postly/domain';
// The push renders its catalog keys HERE, on the worker, per subscription locale: importing the app
// catalog is what registers it (`@postly/i18n`'s own header). A boot imports it anyway; a job test
// that drives this notifier alone would otherwise render every push as `⟦key⟧`.
import '@postly/i18n';
import { send } from '@ultimat3/mail';
import { mailChannel, notifier, pushChannel, t } from '@ultimat3/notify';
import { webPush } from '@ultimat3/pwa';
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
    // Reads that NAME the org the payload carries: a served worker's actor is nobody, so the
    // acting-member reads (`byId`, `memberById`) have no member to scope by.
    const orgId = toOrgId(input.orgId);
    const post = await ctx.posts.inOrg(orgId, toPostId(input.postId));
    if (post === null || post.authorId === input.commenterId) return [];
    const author = await ctx.orgs.memberIn(orgId, toMemberId(post.authorId));
    return [{ id: author.id, to: author.email, locale: author.locale, tz: author.tz }];
  },
  deliver: [
    // Every browser the author subscribed (settings → notifications), each in the locale it
    // subscribed in. The tag is the post: a second comment REPLACES the first notification, and a
    // retried delivery replaces itself instead of showing twice.
    {
      channel: pushChannel<CommentPosted>({
        pusher: webPush(),
        message: ({ event }) => ({
          titleKey: 'push.commentPosted.title',
          bodyKey: 'push.commentPosted.body',
          params: { commenter: event.params.commenter, title: event.params.title },
          url: `/posts/${event.params.postId}`,
          tag: `post:${event.params.postId}`,
          renotify: true,
        }),
      }),
    },
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
