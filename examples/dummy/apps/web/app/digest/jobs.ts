/**
 * The nightly digest. The scheduler fires once, in UTC; the *delivery* is per member, at 09:00
 * on their own wall clock. That is why this is two jobs: one fan-out that computes slots, and one
 * delivery whose idempotency key is the member's local date.
 *
 * `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package.
 */

import { localDateIn, scheduleByZone } from '@postly/core';
import { memberId as toMemberId, orgId as toOrgId } from '@postly/domain';
import { job, t } from '@ultimat3/jobs';
import { send } from '@ultimat3/mail';
import { digestEmail } from './mail';

export const sendDigest = job({
  /**
   * The task passes the UTC date of the occurrence it is firing for — not the worker's clock,
   * which a late or caught-up tick has already moved past. An idempotency key must derive from
   * `input` alone, so an empty payload would make every night's run collide with the first one.
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
          //
          // `batch.at` goes in twice on purpose: as `runAt` it is when the queue may release the
          // job, as `slotAt` it is which digest this is — and a retry moves the first, never the
          // second.
          await deliverDigest.enqueue(
            {
              memberId: member.id,
              localDate: localDateIn(batch.at, zone),
              slotAt: batch.at.getTime(),
            },
            { runAt: batch.at.getTime() },
          );
        }
      });
    }

    return { runDate: input.runDate, zones: new Set(recipients.map((m) => m.tz)).size };
  },
});

export const deliverDigest = job({
  /**
   * `slotAt` is the instant this digest is FOR — the member's 09:00, in epoch ms. It travels in
   * the payload because the queue is allowed to be late: four attempts of exponential backoff
   * put `ctx.now()` hours past the slot, and a window measured from *then* would load a later
   * day's posts than the `localDate` the email prints.
   */
  input: t.object({ memberId: t.uuid, localDate: t.string, slotAt: t.number.int() }),
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

    // The 24h window ends at the slot, never at execution time: the digest dated `localDate`
    // must contain the posts of that day whether it went out on time or after three retries.
    // The member's zone is already inside `slotAt` — the fan-out resolved it with calendar math,
    // so there is nothing left to convert here. Same window `postly.digestPreview` promises.
    const since = new Date(input.slotAt - 86_400_000);
    const posts = await step.run('load-posts', () =>
      ctx.posts.publishedSince(toOrgId(member.orgId), since),
    );

    // An empty digest is not a digest. Skipping still records the step, so a retry does not
    // re-query, and the idempotency key still blocks a second send today.
    if (posts.length === 0) return { sent: false };

    // The org's NAME, because the mail's `{org}` is a name slot — and read after the empty check,
    // so a member with nothing to read costs one statement fewer.
    const org = await step.run('load-org', () => ctx.orgs.byId(toOrgId(member.orgId)));

    await step.run('send', () =>
      send(
        digestEmail,
        { member, posts, localDate: input.localDate, org: org.name },
        { to: member.email, locale: member.locale, tz: member.tz },
      ),
    );
    return { sent: true };
  },
});
