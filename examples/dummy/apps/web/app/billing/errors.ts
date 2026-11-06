/** Errors the billing feature can raise. Codes are stable; the message names the fix. */

import { defineError } from '@ultimat3/core';

/**
 * The vendor refused an invoice because it closed the org's account. Terminal: the same account
 * refuses the same invoice on every attempt, so `settleUpgrade` unwinds on this one — the seats
 * are released and the charge refunded — rather than retrying into a refusal. A job's failure,
 * never a response's.
 */
export const InvoiceRefused = defineError<string>({
  code: 'X_BILLING_INVOICE_REFUSED',
  title: "the billing vendor refused an invoice on the org's account",
  offSocket: true,
  retry: 'terminal',
  cause: (orgId) => `the billing vendor closed org ${orgId}'s account, so it issues no invoice`,
  fix: (orgId) =>
    `x jobs list --name settleUpgrade --state dead --json — reopen org ${orgId}'s account at the vendor, then upgradePlan({ orgId: '${orgId}', plan }) again: the charge was refunded`,
});
