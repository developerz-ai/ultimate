/**
 * job — `settleUpgrade`'s saga through the production worker: a refusal for good on the last step
 * gives back what the earlier steps took, in reverse and once each, and a settled run gives back
 * nothing. Read off the vendor's own call log, the only witness a refund has.
 */

import { expect, jobTest } from '@ultimat3/testing';
import { settleUpgrade } from './jobs/settle-upgrade';
import { closeVendorAccount, vendorCallsFor } from './vendor-payments';

/** Each run's outcome and the code it ended on, `null` for none. */
const outcomes = (trace: { executions: readonly { outcome: string; error?: string }[] }) =>
  trace.executions.map((run) => [run.outcome, run.error?.match(/X_[A-Z_]+/)?.[0] ?? null]);

/** `refund:ch_…` → `ch_…`: the id a call was about. */
const idOf = (call: string | undefined) => call?.slice(call.indexOf(':') + 1);

jobTest(
  'a closed vendor account refunds the charge and releases the seats, in reverse',
  async ({ seed, runJobs }) => {
    const { org } = await seed('dev').pick({ org: 'org:acme' });
    closeVendorAccount(org.id);

    // No `actor`: a served worker is nobody, and the declared tenant is all the run has.
    const trace = await runJobs(settleUpgrade, { orgId: org.id, plan: 'team' });

    // Terminal on the first attempt — no retry charges the card a second time.
    expect(outcomes(trace)).toEqual([['dead-lettered', 'X_BILLING_INVOICE_REFUSED']]);
    const [charge, reserve, ...undone] = vendorCallsFor(org.id);
    expect([charge?.split(':')[0], reserve?.split(':')[0]]).toEqual(['charge', 'reserve']);
    expect(undone).toEqual([`release:${idOf(reserve)}`, `refund:${idOf(charge)}`]);
  },
);

jobTest(
  'a settled upgrade is charged, reserved and invoiced, and undoes nothing',
  async ({ seed, runJobs }) => {
    const { org } = await seed('dev').pick({ org: 'org:tinta' });

    const trace = await runJobs(settleUpgrade, { orgId: org.id, plan: 'team' });

    expect(outcomes(trace)).toEqual([['completed', null]]);
    expect(vendorCallsFor(org.id).map((call) => call.split(':')[0])).toEqual([
      'charge',
      'reserve',
      'invoice',
    ]);
  },
);
