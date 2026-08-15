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
   * Declared with the numbers a human filling this in cannot exceed. Two honest caveats, reported
   * rather than papered over: the limiter keys per ACTOR, then org, then IP (`rateLimitKey`), so
   * "per recipient" is not a scope an app can ask for — the job's idempotency key is what stops a
   * replayed enquiry mailing twice. And the numbers below reach `openapi.json` but not the
   * limiter: `toRoute` selects the bucket named `contactSales`, `defineConfig` has no `http` block
   * to declare one in, and nothing derives a bucket from this declaration — so what is enforced
   * today is still `default`. Stricter-than-enforced, never the reverse, and the gap is the
   * framework's to close.
   */
  rateLimit: { limit: 5, windowMs: 600_000 },
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
