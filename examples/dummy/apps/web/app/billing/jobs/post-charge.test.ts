/**
 * `chargePosting` is the whole of what Postly decides about its books: which accounts a charge
 * moves, and by how much. The framework refuses an unbalanced posting, so the proof here is that
 * every plan, in every billing currency, posts one that nets to zero.
 */

import type { BillingCurrency, PlanCode } from '@postly/domain';
import { PLAN_CODES, priceOf } from '@postly/domain';
import { assertBalancedPosting } from '@ultimat3/jobs';
import { describe, expect, test } from '@ultimat3/testing';
import { chargePosting, postCharge } from './post-charge';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const CURRENCIES: readonly BillingCurrency[] = ['USD', 'EUR'];

describe('chargePosting', () => {
  test('every plan in every currency posts cash in and revenue out, netting to zero', () => {
    for (const plan of PLAN_CODES as readonly PlanCode[]) {
      for (const currency of CURRENCIES) {
        const posting = chargePosting(ORG, 'ch_1', plan, currency);
        expect(() => assertBalancedPosting(posting)).not.toThrow();
        expect(posting.entries.map((entry) => entry.account)).toEqual(['cash', 'revenue']);
        expect(posting.entries[0]?.amount).toEqual(priceOf(plan, currency));
      }
    }
  });

  test('the charge id is the key and the org the tenant: one posting per charge, per org', () => {
    const posting = chargePosting(ORG, 'ch_42', 'team', 'EUR');
    expect([posting.key, posting.orgId]).toEqual(['ch_42', ORG]);
    expect(postCharge.idempotencyKeyFor(posting)).toBe('billing.post-charge:ch_42');
  });
});
