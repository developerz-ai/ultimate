// `postsQuotaWarning`, the posts slice's job — one primitive per file, the layout `x g` writes.
//
// What `createPost`'s meter enqueues when an org crosses 80% of its daily drafts: once per org per
// UTC day, after the draw that crossed it. The input is `@ultimat3/action`'s `MeterWarning` schema,
// never a restatement — the meter's `onWarn` is typed against it, so the two cannot drift.

import { MeterWarning } from '@ultimat3/action';
import { job } from '@ultimat3/jobs';
import { quotaAlert } from '../../quota/jobs/quota-alert';

export const postsQuotaWarning = job({
  input: MeterWarning,
  // One per org, meter and period: the meter already claims the warning once, and this key makes a
  // retried enqueue the same run rather than a second line in the operator's feed.
  idempotencyKey: ({ meter, orgId, periodStart }) =>
    `quota:${meter}:${orgId ?? 'none'}:${periodStart}`,
  // It reads no tenant row — the warning carries every fact it logs — so it acts as no org.
  tenant: 'none',
  retry: { attempts: 3, backoff: 'exponential' },
  async run({ input, ctx, step }) {
    // A structured line, which is what an operator's alerting reads.
    ctx.logger.warn('posts.quota.warning', {
      orgId: input.orgId,
      used: input.used,
      limit: input.limit,
      resetsAt: input.resetsAt,
    });
    // The org's own half — recorded and texted to its owners — runs AS that org (`quotaAlert`'s
    // tenant). A meter counted for no org has nobody to tell.
    const { orgId, meter, used, limit, periodStart, resetsAt } = input;
    if (orgId === null) return;
    await step.run('alert-org', () =>
      quotaAlert.enqueue({ orgId, meter, used, limit, periodStart, resetsAt }),
    );
  },
});
