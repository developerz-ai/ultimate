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
  /**
   * `orgId` rides beside the post id, and it is not redundant with it: `posts`, `members` and
   * `comments` are tenant-scoped, so the first read — `ctx.posts.byId` — is already scoped by the
   * acting actor's org, and a job's actor gets one only from `tenant` below. Reading the org OFF
   * the post to declare it is circular. One org's fanout, so the org belongs in the payload; the
   * escape hatch (`tenant: 'none'` plus `crossTenant`) is for a sweep that genuinely spans orgs.
   */
  input: t.object({ postId: t.uuid, orgId: t.uuid }),
  /** The post alone: one notification per published post, whichever org it belongs to. */
  idempotencyKey: ({ postId }) => `notify:${postId}`,
  tenant: ({ orgId }) => orgId,
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

    for (const member of recipients) {
      // One step per recipient, because the step IS the retry unit: a provider blip on recipient
      // 40 of 50 re-sends recipient 40 and replays the other 39 from storage in microseconds. One
      // step around the whole loop re-sent all 50, which is a mailbox full of duplicates for one
      // transient 503. The member's id names the step because the id survives a replay — a loop
      // index does not, and a step name is the replay key (X_STEP_DUPLICATE).
      await step.run(`send:${member.id}`, () =>
        send(
          postPublished,
          { post, member, org: org.name },
          { to: member.email, locale: member.locale },
        ),
      );
    }
  },
});
