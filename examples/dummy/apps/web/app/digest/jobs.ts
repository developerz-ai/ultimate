/**
 * The nightly digest. The scheduler fires once, in UTC; the *delivery* is per member, at 09:00
 * on their own wall clock. That is why this is two jobs: one fan-out that computes slots, and one
 * delivery whose idempotency key is the slot it is for.
 *
 * The delivery's unit is one (org, zone) group, not one member. Both halves of that follow from
 * what a digest costs: the post window is org-scoped and bounded by the group's own instant, so a
 * per-member delivery re-ran the identical `publishedSince` once per reader and re-read the row
 * it was handed the id of. A group runs each of those once and mails everybody from the result.
 * The member's promise is unchanged — every member of a group shares a zone, so 09:00 still means
 * 09:00 where they are.
 *
 * `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package.
 */

import { localDateIn, previousDigestAt, scheduleByOrgAndZone } from '@postly/core';
import { SUPPORTED_ZONES, orgId as toOrgId } from '@postly/domain';
import { assert } from '@ultimat3/core';
import { defineFlag, isEnabled } from '@ultimat3/flags';
import { job, t } from '@ultimat3/jobs';
import { send } from '@ultimat3/mail';
import { digestEmail } from './mail';

/** The shape the nightly task sends, and the only one the slot arithmetic below can read. */
const RUN_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The occurrence's own instant: midnight UTC of the date the task fired for.
 *
 * Asserted here rather than narrowed on `input:` — tightening a shipped job's input schema is a
 * breaking contract change (`x verify`'s `contract-diff` step is where that is decided), and the
 * payloads already on the queue were written against `t.string`. Without the guard a malformed
 * date reaches `toZoned` as an Invalid Date and throws a `RangeError` naming neither this job nor
 * the field.
 */
const startOfRunDate = (runDate: string): Date => {
  assert(
    RUN_DATE.test(runDate),
    `sendDigest was enqueued with runDate ${JSON.stringify(runDate)}, which is not YYYY-MM-DD`,
    'enqueue it from the nightly task, which formats the occurrence: x jobs show sendDigest --json',
  );
  return new Date(`${runDate}T00:00:00.000Z`);
};

/**
 * Ops kill switch: flip this off and the nightly fan-out stops scheduling deliveries without a
 * deploy. `permanent`, not `temporary` — this is a real ops lever for "mail is misbehaving,
 * stop sending", not scaffolding around an in-progress change, so it carries no `expiresAt`.
 */
export const digestEnabled = defineFlag({
  kind: 'permanent',
  key: 'digest.enabled',
  description: 'ops kill switch for the nightly digest fan-out',
  targeting: { default: true },
});

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
    // Checked once per run, off the ambient actor — sync, so no step boundary earns anything.
    // Off means the fan-out enqueues nothing this occurrence; `deliverDigest` never even sees it.
    if (!isEnabled(digestEnabled.key, ctx.actor)) {
      return { runDate: input.runDate, groups: 0 };
    }

    const recipients = await step.run('load-recipients', () => ctx.orgs.allDigestRecipients());

    // One `runAt` per zone rather than per member — 500 members in Madrid share one computation,
    // and the slot is DST-correct because @postly/core does calendar math, not millisecond math.
    //
    // Based on the OCCURRENCE, never `ctx.now()`: this line runs on every attempt while only the
    // enqueues already stored replay, so a second attempt taken after a zone's 09:00 had passed
    // would roll that zone's slot into tomorrow and enqueue the groups it had not reached yet
    // with a next-day `slotAt` and `localDate` — a different digest, under a step name carrying
    // no date to catch it. `runDate` is the same on every attempt, so the slots are too.
    const groups = scheduleByOrgAndZone(recipients, startOfRunDate(input.runDate));

    for (const group of groups) {
      // ONE enqueue per step, so the step is the retry unit it claims to be: a driver blip on
      // group 40 of 50 re-enqueues group 40 and replays the other 39 from storage. A loop inside
      // one step would replay every enqueue in it — deduped by the delivery's idempotency key,
      // and still a queue round trip per member for nothing.
      //
      // `group.at` goes in twice on purpose: as `runAt` it is when the queue may release the job,
      // as `slotAt` it is which digest this is — and a retry moves the first, never the second.
      await step.run(`schedule:${group.orgId}:${group.zone}`, () =>
        deliverDigest.enqueue(
          {
            orgId: group.orgId,
            zone: group.zone,
            localDate: localDateIn(group.at, group.zone),
            slotAt: group.at.getTime(),
          },
          { runAt: group.at.getTime() },
        ),
      );
    }

    return { runDate: input.runDate, groups: groups.length };
  },
});

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
