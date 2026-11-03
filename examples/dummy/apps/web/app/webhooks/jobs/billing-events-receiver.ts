/**
 * The billing provider's events, received. `webhookReceiver()` is a factory over `job()`: the
 * route reads the exact bytes, `verify` checks the vendor's hmac and reads the event OUT OF THE
 * SIGNED BYTES — its id included, so one captured signature cannot be replayed under fresh ids —
 * the event is queued durably and only then acknowledged. `handle` receives that verified payload
 * in the worker and never re-verifies, so a retry an hour later is not refused by a closed window.
 *
 * Declaring it is its registration: `defineApi({ jobs })` lists it, and the boot mounts its route.
 * Which vendor and what an event means stay Postly's — no vendor verifier ships.
 */

import { verifyBodyHmac } from '@ultimat3/http';
import { t, webhookReceiver } from '@ultimat3/jobs';
import { BillingEventUnreadable } from '../errors';

/** Where the vendor sends events, and the header its signature rides in. */
export const BILLING_EVENTS_PATH = '/hooks/billing';
export const BILLING_SIGNATURE_HEADER = 'x-billing-signature';

/** The part of the vendor's payload Postly reads. Postly's schema, never the framework's. */
const BillingEvent = t.object({ id: t.string, type: t.string, invoice: t.string });

/**
 * Comma-separated, so a rotation keeps the old secret live beside the new one. Unset is `['']`,
 * which `verifyBodyHmac` refuses as `X_CONFIG_INVALID` — never a mac under an empty key.
 */
const billingSecrets = (): readonly string[] =>
  (Bun.env['BILLING_WEBHOOK_SECRET'] ?? '').split(',');

/**
 * The verified text as the event. `JSON.parse`'s own message quotes the token it stopped at, which
 * is a piece of the body, so it is replaced whole by a code that names none of it.
 */
function readBillingEvent(text: string | null) {
  let value: unknown;
  try {
    value = JSON.parse(text ?? '');
  } catch {
    throw new BillingEventUnreadable('is not JSON');
  }
  try {
    return BillingEvent.parse(value, 'billing event');
  } catch {
    throw new BillingEventUnreadable('does not carry a string id, type and invoice');
  }
}

export const billingEventsReceiver = webhookReceiver({
  name: 'billing.events',
  path: BILLING_EVENTS_PATH,
  // The vendor's account is Postly's, not an org's: the event names the invoice, not a tenant.
  tenant: 'none',
  verify: (inbound) => {
    const { text } = verifyBodyHmac({
      bytes: inbound.bytes,
      secret: billingSecrets(),
      given: inbound.headers.get(BILLING_SIGNATURE_HEADER),
      encoding: 'hex',
      prefix: 'sha256=',
    });
    const event = readBillingEvent(text);
    return { eventId: event.id, topic: event.type, payload: event };
  },
  // At least once per event id: a redelivery after this settles runs again, so a write here is an
  // upsert keyed by `eventId`, never an insert.
  handle: async ({ eventId, payload }) => ({
    eventId,
    type: payload.type,
    invoice: payload.invoice,
  }),
  retry: { attempts: 5, backoff: 'exponential' },
});
