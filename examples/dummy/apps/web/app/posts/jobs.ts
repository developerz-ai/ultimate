/**
 * Work that must outlive the request that caused it. `publishPost` enqueues this in the same
 * transaction as the publish, so a rolled-back publish never mails anybody and a committed one
 * always does.
 */

import { job } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { postPublished } from './mail';

export const notifySubscribers = job({
  input: t.object({ postId: t.uuid }),
  idempotencyKey: ({ postId }) => `notify:${postId}`,
  retry: { attempts: 5, backoff: 'exponential' },
  queue: 'mail',
  /** One fanout per post at a time; a retry cannot race its own first attempt. */
  concurrency: { key: ({ postId }) => postId, limit: 1 },
  async run({ input, step, ctx }) {
    const post = await step.run('load-post', () => ctx.posts.byId(input.postId));

    // Tier 1 realtime: everyone already looking at the org sees it without a refetch.
    await step.run('announce', () =>
      ctx.channel(`org:${post.orgId}`).publish({ type: 'post.published', postId: post.id }),
    );

    const recipients = await step.run('load-recipients', () =>
      ctx.orgs.digestRecipients(post.orgId),
    );

    // The step is the retry unit: a provider blip re-sends this step only, with the loads
    // replayed from storage in microseconds.
    await step.run('send', () =>
      ctx.mail.sendEach(
        recipients.map((member) => ({
          to: member.email,
          locale: member.locale,
          template: postPublished,
          data: { post, member },
        })),
      ),
    );
  },
});
