// `settleUpgrade`, the billing slice's saga — one primitive per file, the layout `x g` writes.
//
// Charge, reserve seats, invoice: three vendor calls that each take something, so a failure for
// good on the third gives back what the first two took, last-in first-out. A `try/catch` cannot:
// it refunds on a retryable blip, before the retry that charges again from replay.

import { PLAN_CATALOG, PLAN_CODES, orgId as toOrgId } from '@postly/domain';
import { job, t } from '@ultimat3/jobs';
import {
  chargeCard,
  issueInvoice,
  refundCharge,
  releaseSeats,
  reserveSeats,
} from '../vendor-payments';
import { chargePosting, postCharge } from './post-charge';

export const settleUpgrade = job({
  input: t.object({ orgId: t.uuid, plan: t.enumerated(...PLAN_CODES) }),
  idempotencyKey: ({ orgId, plan }) => `settle-upgrade:${orgId}:${plan}`,
  // The org the payload names: `ctx.orgs.byId` counts `members`, which is tenant-scoped.
  tenant: ({ orgId }) => orgId,
  retry: { attempts: 5, backoff: 'exponential' },
  // What makes `compensate:` legal below, and what keeps an unwind alive through a crash on the
  // final attempt.
  compensates: true,
  async run({ input, step, ctx }) {
    const org = await step.run('load-org', () => ctx.orgs.byId(toOrgId(input.orgId)));
    // `once`: a card charge is never sent twice on a replay. A crash mid-call leaves "did it
    // happen?" to a person (`x jobs resolve-step`), which is the answer a charge deserves.
    const charge = await step.run(
      'charge',
      () => chargeCard(org.id, input.plan, org.billingCurrency),
      { once: true, compensate: (chargeId) => refundCharge(chargeId) },
    );
    await step.run('reserve-seats', () => reserveSeats(org.id, PLAN_CATALOG[input.plan].seats), {
      compensate: (reservationId) => releaseSeats(reservationId),
    });
    await step.run('invoice', () => issueInvoice(org.id, charge));
    // The books, once the money is final: a posting keyed by the charge, so a replay is one posting.
    await step.run('post-ledger', () =>
      postCharge.enqueue(chargePosting(org.id, charge, input.plan, org.billingCurrency)),
    );
  },
});
