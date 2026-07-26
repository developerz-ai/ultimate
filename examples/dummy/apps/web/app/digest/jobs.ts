/**
 * The nightly digest. The scheduler fires once, in UTC; the *delivery* is per member, at 09:00
 * on their own wall clock. That is why this is two jobs: one fan-out that computes slots, and one
 * delivery whose idempotency key is the member's local date.
 */

import { localDateIn, nextDigestAt, scheduleByZone } from '@postly/core';
import { job } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
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
      await step.run(`schedule:${zone}`, () =>
        ctx.jobs.enqueueMany(
          batch.members.map((member) => [
            deliverDigest,
            { memberId: member.id, localDate: localDateIn(batch.at, zone) },
            { runAt: batch.at },
          ]),
        ),
      );
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
  concurrency: { key: ({ memberId }) => memberId, limit: 1 },
  async run({ input, step, ctx }) {
    const member = await step.run('load-member', () => ctx.orgs.memberById(input.memberId));

    const since = nextDigestAt(ctx.now(), member.tz, 9);
    const posts = await step.run('load-posts', () =>
      ctx.posts.publishedSince(member.orgId, new Date(since.getTime() - 86_400_000)),
    );

    // An empty digest is not a digest. Skipping still records the step, so a retry does not
    // re-query, and the idempotency key still blocks a second send today.
    if (posts.length === 0) return { sent: false };

    await step.run('send', () =>
      ctx.mail.send(digestEmail, { member, posts, localDate: input.localDate }),
    );
    return { sent: true };
  },
});
