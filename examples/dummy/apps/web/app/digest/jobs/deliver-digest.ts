// `deliverDigest`, the digest slice's job — one primitive per file, the layout `x g` writes.
//
// The nightly digest. The scheduler fires once, in UTC; the *delivery* is per member, at 09:00
// on their own wall clock. That is why this is two jobs: one fan-out that computes slots, and one
// delivery whose idempotency key is the slot it is for.
//
// The delivery's unit is one (org, zone) group, not one member. Both halves of that follow from
// what a digest costs: the post window is org-scoped and bounded by the group's own instant, so a
// per-member delivery re-ran the identical `publishedSince` once per reader and re-read the row
// it was handed the id of. A group runs each of those once and mails everybody from the result.
// The member's promise is unchanged — every member of a group shares a zone, so 09:00 still means
// 09:00 where they are.
//
// `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package.

import { previousDigestAt } from '@postly/core';
import { SUPPORTED_ZONES, orgId as toOrgId } from '@postly/domain';
import { job, t } from '@ultimat3/jobs';
import { send } from '@ultimat3/mail';
import { digestEmail } from '../mail';

export const deliverDigest = job({
  /**
   * `slotAt` is the instant this digest is FOR — the group's 09:00, in epoch ms. It travels in
   * the payload because the queue is allowed to be late: four attempts of exponential backoff
   * put `ctx.now()` hours past the slot, and a window measured from *then* would load a later
   * day's posts than the `localDate` the email prints.
   *
   * `orgId` and `zone` travel for the same reason the window does: they are what the delivery is
   * FOR. Reading them back off a member row is the read this payload exists to delete.
   */
  input: t.object({
    orgId: t.uuid,
    zone: t.enumerated(...SUPPORTED_ZONES),
    localDate: t.string,
    slotAt: t.number.int(),
  }),
  /** Local date, not UTC date: two zones inside one org are two different digests. */
  idempotencyKey: ({ orgId, zone, localDate }) => `digest:${orgId}:${zone}:${localDate}`,
  /** One group is one org: the posts, the org row and the readers are all read under this id. */
  tenant: ({ orgId }) => orgId,
  retry: { attempts: 4, backoff: 'exponential' },
  queue: 'mail',
  /** One group in flight at a time, so a retry cannot race its own first attempt. */
  concurrency: 1,
  async run({ input, step, ctx }) {
    const orgId = toOrgId(input.orgId);

    // The window ends at the slot, never at execution time: the digest dated `localDate` must
    // contain the posts of that day whether it went out on time or after three retries. It OPENS
    // at the previous slot — the same calendar math, not `slotAt - 86_400_000`, because
    // consecutive slots are 23h apart on spring-forward and 25h on autumn-back, and a fixed day
    // of milliseconds mails those posts twice in March and to nobody in October. Same window
    // `postly.digestPreview` promises.
    //
    // ONE read for every reader of this digest, which is the whole reason the group exists.
    const since = previousDigestAt(new Date(input.slotAt), input.zone);
    const posts = await step.run('load-posts', () => ctx.posts.publishedSince(orgId, since));

    // An empty digest is not a digest. Skipping still records the step, so a retry does not
    // re-query — and it skips the two reads below, so an org with nothing to say costs one
    // statement in total.
    if (posts.length === 0) return { sent: 0 };

    // The org's NAME, because the mail's `{org}` is a name slot.
    const org = await step.run('load-org', () => ctx.orgs.byId(orgId));

    // Read at the slot rather than carried from the fan-out, and that is the point: a member who
    // opted out during the night is gone from this list, and a page of rows in a job payload is
    // the thing this repo refuses everywhere else. One statement, whatever the group's size.
    const recipients = await step.run('load-recipients', async () =>
      (await ctx.orgs.digestRecipients(orgId)).filter((member) => member.tz === input.zone),
    );

    for (const member of recipients) {
      // One step per member: the step IS the retry unit, so a provider blip on reader 40 of 50
      // re-sends reader 40 and replays the other 39 from storage in microseconds. The member's
      // id names it because the id is what survives a replay — a loop index does not.
      await step.run(`send:${member.id}`, () =>
        send(
          digestEmail,
          { member, posts, localDate: input.localDate, org: org.name },
          { to: member.email, locale: member.locale, tz: member.tz },
        ),
      );
    }

    return { sent: recipients.length };
  },
});
