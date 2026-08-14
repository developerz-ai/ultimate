/**
 * Work that must outlive the request that caused it. `publishPost` enqueues this in the same
 * transaction as the publish, so a rolled-back publish never mails anybody and a committed one
 * always does.
 *
 * `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package.
 */

import { orgId as toOrgId, postId as toPostId } from '@postly/domain';
import { job, t } from '@ultimat3/jobs';
import { send } from '@ultimat3/mail';
import { postPublished } from './mail';

export const notifySubscribers = job({
  input: t.object({ postId: t.uuid }),
  idempotencyKey: ({ postId }) => `notify:${postId}`,
  retry: { attempts: 5, backoff: 'exponential' },
  queue: 'mail',
  /** One fanout in flight at a time; a retry cannot race its own first attempt. */
  concurrency: 1,
  async run({ input, step, ctx }) {
    const post = await step.run('load-post', () => ctx.posts.byId(toPostId(input.postId)));

    // Tier 1 realtime: everyone already looking at the org sees it without a refetch.
    await step.run('announce', () =>
      ctx.channel(`org:${post.orgId}`).publish({ type: 'post.published', postId: post.id }),
    );

    const recipients = await step.run('load-recipients', () =>
      ctx.orgs.digestRecipients(toOrgId(post.orgId)),
    );

    // The org's NAME, because the mail's `{org}` is a name slot. Its own step, so a provider blip
    // on the send below replays neither this read nor the two above it.
    const org = await step.run('load-org', () => ctx.orgs.byId(toOrgId(post.orgId)));

    // The step is the retry unit: a provider blip re-sends this step only, with the loads
    // replayed from storage in microseconds.
    await step.run('send', async () => {
      for (const member of recipients) {
        await send(
          postPublished,
          { post, member, org: org.name },
          { to: member.email, locale: member.locale },
        );
      }
    });
  },
});
