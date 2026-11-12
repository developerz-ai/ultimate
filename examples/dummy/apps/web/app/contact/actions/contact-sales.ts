/**
 * The one thing an anonymous visitor may ask this server to do. It exists because `/pricing`'s
 * contact modal has to call something: an island's props are JSON, so a callback cannot cross the
 * server/browser seam and the island calls the action itself.
 *
 * `t` comes from @ultimat3/action, not @ultimat3/schema: an action file imports one package.
 */

import { BILLING_CURRENCIES, PLAN_CODES, SUPPORTED_LOCALES, typedBudget } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import { contactSubmit } from '../../../shared/policies';
import { sendSalesReceipt } from '../jobs/send-sales-receipt';

/** Long enough for a real question, short enough that the row and the idempotency key stay sane. */
export const ENQUIRY_MAX = 2_000;

/** A typed amount, symbol and separators included: nobody's budget is longer than this. */
const BUDGET_TEXT_MAX = 40;

export const contactSales = action({
  // The plan and the currency are enumerations off the catalog, not free text: the page renders
  // from the same two lists, so an enquiry can never quote a plan Postly does not sell.
  input: t.object({
    email: t.email,
    plan: t.enumerated(...PLAN_CODES),
    currency: t.enumerated(...BILLING_CURRENCIES),
    message: t.string.min(1).max(ENQUIRY_MAX),
    locale: t.enumerated(...SUPPORTED_LOCALES),
    /**
     * The monthly budget as the visitor TYPED it — `1.234,56` on the Spanish page — so it is text,
     * read in `locale` by the handler. Never a number field: a browser's parse of `1.234` is 1.234.
     */
    budget: t.string.max(BUDGET_TEXT_MAX).optional(),
  }),
  /**
   * A receipt, not the enquiry echoed back. The visitor is anonymous, so there is nothing here
   * they are entitled to read that they did not just type.
   */
  output: t.object({ received: t.boolean }),
  /**
   * `allow(...)`, never a missing policy: "anyone may do this" is a declaration on the public
   * surface exactly as `publicPostRead` is, and a missing one is a build error.
   *
   * And no `mcp` block, which is the other half of the same decision: this action must never be
   * agent-callable. It takes no session and no grant, and it sends mail to an address the CALLER
   * supplies — a tool for it hands any agent a one-call mail relay pointed wherever it likes.
   * Every other action here exposes one; this is the app's single exception, and this is why.
   */
  policy: contactSubmit,
  /**
   * A public endpoint that sends mail is the one shape that must not sit on the generic bucket.
   * `default` is 120 burst / 2 per second per IP (`DEFAULT_RATE_LIMIT`, packages/http), which is a
   * page's read allowance, not a contact form's.
   *
   * Declared with the numbers a human filling this in cannot exceed, and these are the numbers
   * that run — on every surface: `invoke` spends this bucket whether the call came over HTTP, an
   * MCP tool or a job, and the route is not also held to `default`. The same `toBucket`
   * conversion feeds `openapi.json`, so the published contract and the limiter cannot disagree.
   *
   * One honest caveat: the limiter keys per ACTOR, then org, then IP (`rateLimitSpends`), so "per
   * recipient" is not a scope an app can ask for — the job's idempotency key is what stops a
   * replayed enquiry mailing twice.
   */
  rateLimit: { limit: 5, windowMs: 600_000 },
  /**
   * With scripting off the pricing page's form posts natively: the browser lands back on the
   * form rather than on `{"received":true}`. `/pricing` is `isr` — one document for every visitor
   * — so it cannot read the outcome (`useActionAnswer` is `null` there); with scripting on the
   * island calls this through the typed client and shows the answer in place.
   */
  native: { success: () => '/pricing#contact' },
  async handle({ input }) {
    // Read here, in the visitor's locale, so a typo is a 422 on THIS request (`X_MONEY_INPUT_INVALID`)
    // the form can show — not a receipt minutes later quoting a number they never meant.
    const typed = input.budget?.trim() ?? '';
    const budget = typed === '' ? null : typedBudget(typed, input.currency, input.locale);
    // Enqueued rather than sent inline: mail renders in the worker role, in the recipient's
    // locale, and the visitor's answer must not wait on an SMTP round trip.
    await sendSalesReceipt.enqueue({
      email: input.email,
      plan: input.plan,
      currency: input.currency,
      message: input.message,
      locale: input.locale,
      budget,
    });
    return { received: true };
  },
});
