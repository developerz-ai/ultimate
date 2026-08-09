/**
 * The nightly digest. The scheduler fires once, in UTC; the *delivery* is per member, at 09:00
 * on their own wall clock. That is why this is two jobs: one fan-out that computes slots, and one
 * delivery whose idempotency key is the member's local date.
 *
 * `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package.
 */

import { localDateIn, nextDigestAt, scheduleByZone } from '@postly/core';
import { memberId as toMemberId, orgId as toOrgId } from '@postly/domain';
import { job, t } from '@ultimat3/jobs';
import { send } from '@ultimat3/mail';
import { digestEmail } from './mail';

export const sendDigest = job({
  /**
   * The task passes its own tick date. An idempotency key must derive from `input` alone, so an
   * empty payload would make every night's run collide with the first one.
   */
  input: t.object({ runDate: t.string }),
  idempotencyKey: ({ runDate }) => `digest:${runDate}`,
  retry: { attempts: 3, backoff: 'exponential' },
  queue: 'digest',
  async run({ input, step, ctx }) {
    const recipients = await step.run('load-recipients', () => ctx.orgs.allDigestRecipients());

    // One `runAt` per zone rather than per member: 500 members in Madrid share one computation,
    // and the slot is DST-correct because @postly/core does calendar math, not millisecond math.
    for (const [zone, batch] of scheduleByZone(recipients, ctx.now())) {
      await step.run(`schedule:${zone}`, async () => {
        for (const member of batch.members) {
          // The handle enqueues itself, so the delivery's retry policy, idempotency key and queue
          // come from its own declaration rather than from this call site.
          await deliverDigest.enqueue(
            { memberId: member.id, localDate: localDateIn(batch.at, zone) },
            { runAt: batch.at.getTime() },
          );
        }
      });
    }

    return { runDate: input.runDate, zones: new Set(recipients.map((m) => m.tz)).size };
  },
});

export const deliverDigest = job({
  input: t.object({ memberId: t.uuid, localDate: t.string }),
  /** Local date, not UTC date: two members in different zones are two different digests. */
  idempotencyKey: ({ memberId, localDate }) => `digest:${memberId}:${localDate}`,
  retry: { attempts: 4, backoff: 'exponential' },
  queue: 'mail',
  /** One delivery in flight at a time, so a retry cannot race its own first attempt. */
  concurrency: 1,
  async run({ input, step, ctx }) {
    const member = await step.run('load-member', () =>
      ctx.orgs.memberById(toMemberId(input.memberId)),
    );

    const since = nextDigestAt(ctx.now(), member.tz);
    const posts = await step.run('load-posts', () =>
      ctx.posts.publishedSince(toOrgId(member.orgId), new Date(since.getTime() - 86_400_000)),
    );

    // An empty digest is not a digest. Skipping still records the step, so a retry does not
    // re-query, and the idempotency key still blocks a second send today.
    if (posts.length === 0) return { sent: false };

    await step.run('send', () =>
      send(
        digestEmail,
        { member, posts, localDate: input.localDate },
        { to: member.email, locale: member.locale, tz: member.tz },
      ),
    );
    return { sent: true };
  },
});
