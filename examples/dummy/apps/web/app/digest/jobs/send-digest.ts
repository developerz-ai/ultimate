// `sendDigest`, the digest slice's job — one primitive per file, the layout `x g` writes.
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

import { localDateIn, scheduleByOrgAndZone } from '@postly/core';
import { assert } from '@ultimat3/core';
import { defineFlag, isEnabled } from '@ultimat3/flags';
import { job, t } from '@ultimat3/jobs';
import { deliverDigest } from './deliver-digest';

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
  /**
   * No org, and that is the point of the fan-out: it reads every opted-in member in every org to
   * decide which (org, zone) groups exist tonight. `'none'` fails closed on a tenant-scoped read,
   * so the one statement that spans orgs says so out loud — `allDigestRecipients` in
   * `app/orgs/repo.ts` is wrapped in `crossTenant()`. Every read BELOW the fan-out belongs to one
   * org, which is why `deliverDigest` declares one.
   */
  tenant: 'none',
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
