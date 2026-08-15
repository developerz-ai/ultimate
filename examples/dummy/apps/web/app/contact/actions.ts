/**
 * The one thing an anonymous visitor may ask this server to do. It exists because `/pricing`'s
 * contact modal has to call something: an island's props are JSON, so a callback cannot cross the
 * server/browser seam and the island calls the action itself.
 *
 * `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
 */

import { BILLING_CURRENCIES, PLAN_CODES, SUPPORTED_LOCALES } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import { contactSubmit } from '../../shared/policies';
import { sendSalesReceipt } from './jobs';

/** Long enough for a real question, short enough that the row and the idempotency key stay sane. */
export const ENQUIRY_MAX = 2_000;

export const contactSales = action({
  // The plan and the currency are enumerations off the catalog, not free text: the page renders
  // from the same two lists, so an enquiry can never quote a plan Postly does not sell.
  input: t.object({
    email: t.email,
    plan: t.enumerated(...PLAN_CODES),
    currency: t.enumerated(...BILLING_CURRENCIES),
    message: t.string.min(1).max(ENQUIRY_MAX),
    locale: t.enumerated(...SUPPORTED_LOCALES),
  }),
  /**
   * A receipt, not the enquiry echoed back. The visitor is anonymous, so there is nothing here
   * they are entitled to read that they did not just type.
   */
  output: t.object({ received: t.boolean }),
  // `allow(...)`, never a missing policy: "anyone may do this" is a declaration on the public
  // surface exactly as `publicPostRead` is, and a missing one is a build error.
  policy: contactSubmit,
  async handle({ input }) {
    // Enqueued rather than sent inline: mail renders in the worker role, in the recipient's
    // locale, and the visitor's answer must not wait on an SMTP round trip.
    await sendSalesReceipt.enqueue({
      email: input.email,
      plan: input.plan,
      currency: input.currency,
      message: input.message,
      locale: input.locale,
    });
    return { received: true };
  },
});
