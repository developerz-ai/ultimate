/**
 * Mail sent to Postly's support address, received. `inboundMail()` is a factory over
 * `webhookReceiver()`, itself a factory over `job()`: the door proves Resend's Svix signature over
 * the exact bytes and queues the email id; the worker reads the raw message from Resend, parses it
 * under bounds and stores its attachments, and `handle` gets one typed message.
 *
 * Declaring it is its registration: `defineApi({ jobs })` lists it, and the boot mounts its route.
 * The provider is a thunk because every role imports this file and only the web role receives:
 * an unset secret is refused on the first delivery, never at a worker's boot.
 */

import { inboundMail, resendInbound } from '@ultimat3/mail/inbound';

/** Where Resend's receiving webhook posts. */
export const SUPPORT_INBOX_PATH = '/hooks/mail/support';

export const supportInbox = inboundMail({
  name: 'contact.support-inbox',
  path: SUPPORT_INBOX_PATH,
  provider: () =>
    resendInbound({
      secret: Bun.env['RESEND_INBOUND_SECRET'] ?? '',
      apiKey: Bun.env['RESEND_API_KEY'] ?? '',
    }),
  // The support address is Postly's, not an org's: a ticket is triaged before it has a tenant.
  tenant: 'none',
  // At least once per message: a write here is keyed by `message.eventId`, never a blind insert.
  handle: async ({ message }) => ({
    eventId: message.eventId,
    from: message.from?.address,
    subject: message.subject,
    attachments: message.attachments.map((file) => (file.stored ? file.key : file.refusal)),
  }),
  retry: { attempts: 5, backoff: 'exponential' },
});
