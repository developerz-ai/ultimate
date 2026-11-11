// `quotaAlert`, the quota slice's job — one primitive per file, the layout `x g` writes.
//
// An org crossed the warning line of a meter (`posts/jobs/posts-quota-warning.ts` queues this): the
// crossing is recorded in `quota_alerts`, the month-partitioned history, then texted to the org's
// owners. Two steps, so a retry after the record never writes it again and never re-queues a
// text the first attempt already queued.
//
// `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package.

import { orgId as toOrgId } from '@postly/domain';
import { job, t } from '@ultimat3/jobs';
import { plainDateUtc } from '@ultimat3/time';
import { recordAlert } from '../repo';
import { quotaAlertSms } from './quota-alert-sms';

export const quotaAlert = job({
  input: t.object({
    orgId: t.uuid,
    meter: t.string.max(60),
    used: t.number.int().min(0),
    limit: t.number.int().min(0),
    /** ISO instants, as `MeterWarning` carries them. */
    periodStart: t.string,
    resetsAt: t.string,
  }),
  idempotencyKey: ({ orgId, meter, periodStart }) => `quota.alert:${meter}:${orgId}:${periodStart}`,
  // The org that crossed the line: the record is that org's row, the owners that org's members.
  tenant: ({ orgId }) => orgId,
  retry: { attempts: 3, backoff: 'exponential' },
  async run({ input, step }) {
    await step.run('record', () =>
      recordAlert({
        orgId: toOrgId(input.orgId),
        meter: input.meter,
        used: input.used,
        limit: input.limit,
        // The meter's period is a UTC day: the date its first instant falls on, in UTC.
        day: plainDateUtc(new Date(input.periodStart)),
        resetsAt: new Date(input.resetsAt),
      }),
    );
    const { orgId, meter, used, limit, periodStart } = input;
    await step.run('text-owners', () =>
      quotaAlertSms.enqueue({ params: { orgId, meter, used, limit, periodStart } }),
    );
  },
});
