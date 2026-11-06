/**
 * The billing vendor's payments surface, faked in memory like its feed (`vendor.ts`): a charge, a
 * seat reservation and an invoice per org, each with the call that undoes it, and the log of every
 * call in order — what `settleUpgrade`'s job test reads to prove an unwind ran last-in first-out.
 */

import { type BillingCurrency, type PlanCode, priceOf } from '@postly/domain';
import { InvoiceRefused } from './errors';

/** Every call the vendor took, oldest first: `charge:<id>`, `refund:<id>`, `reserve:<id>`, … */
const calls: string[] = [];
/** Accounts the vendor closed: it still refunds and releases on them, it issues no invoice. */
const closed = new Set<string>();

const record = (call: string): string => {
  calls.push(call);
  return call.slice(call.indexOf(':') + 1);
};

/** Takes a month of `plan` in the org's currency, at the catalog's price. */
export const chargeCard = async (
  orgId: string,
  plan: PlanCode,
  currency: BillingCurrency,
): Promise<string> => {
  const { minor } = priceOf(plan, currency);
  return record(`charge:ch_${orgId}_${minor}${currency}`);
};

export const refundCharge = async (chargeId: string): Promise<void> => {
  record(`refund:${chargeId}`);
};

export const reserveSeats = async (orgId: string, seats: number): Promise<string> =>
  record(`reserve:rs_${orgId}_${seats}`);

export const releaseSeats = async (reservationId: string): Promise<void> => {
  record(`release:${reservationId}`);
};

/** The last step, and the one that can refuse for good: a closed account takes no invoice. */
export const issueInvoice = async (orgId: string, chargeId: string): Promise<string> => {
  if (closed.has(orgId)) throw new InvoiceRefused(orgId);
  return record(`invoice:in_${chargeId}`);
};

/** The vendor's side of an account closure, as its dashboard would do it. */
export const closeVendorAccount = (orgId: string): void => {
  closed.add(orgId);
};

/** What the vendor was asked, in order, for one org. */
export const vendorCallsFor = (orgId: string): readonly string[] =>
  calls.filter((call) => call.includes(orgId));
