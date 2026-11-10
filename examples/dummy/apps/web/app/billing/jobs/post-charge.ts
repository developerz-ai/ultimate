// `postCharge`, the billing slice's books: a settled upgrade's charge as a double-entry posting —
// cash in, revenue out, the same amount — written by `ledger()` into `ledger_lines`. The account
// names are Postly's; the framework refuses a posting that does not net to zero per currency.

import { driver, ledgerLines } from '@postly/db';
import type { BillingCurrency, PlanCode } from '@postly/domain';
import { priceOf } from '@postly/domain';
import type { LedgerPosting } from '@ultimat3/jobs';
import { entityLedgerBook, ledger } from '@ultimat3/jobs';

export const postCharge = ledger({
  name: 'billing.post-charge',
  // The org the posting names: its lines live under it.
  tenant: (posting) => posting.orgId ?? 'none',
  book: () => entityLedgerBook({ driver, entity: ledgerLines }),
});

/** The charge as a posting, keyed by the vendor's charge id: one posting per charge, per org. */
export const chargePosting = (
  orgId: string,
  chargeId: string,
  plan: PlanCode,
  currency: BillingCurrency,
): LedgerPosting => {
  const price = priceOf(plan, currency);
  return {
    key: chargeId,
    orgId,
    entries: [
      { account: 'cash', amount: price },
      { account: 'revenue', amount: { ...price, minor: -price.minor } },
    ],
  };
};
