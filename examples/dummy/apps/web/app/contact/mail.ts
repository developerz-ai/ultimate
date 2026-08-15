/**
 * The receipt a sales enquiry earns. A visitor who typed an address into a form on an anonymous
 * page has no account and no row, so the enquiry IS the payload — there is nothing to load it
 * back from and nothing to key it by but the address the visitor gave.
 */

import { blocks, defineMail, type Infer, t } from '@ultimat3/mail';

/**
 * One declaration for the enquiry, shared by the mail, the job and the action's own input. The
 * plan and currency are the ones the page was showing when the modal opened, not a second choice
 * made inside it — `/pricing` renders one currency per URL, and the enquiry quotes what was read.
 */
export const SalesEnquiry = t.object({
  email: t.email,
  plan: t.string,
  currency: t.string,
  message: t.string,
});

export type SalesEnquiry = Infer<typeof SalesEnquiry>;

export const salesReceiptEmail = defineMail<SalesEnquiry>({
  id: 'contact.sales-receipt',
  subject: 'mail.contactSales.subject',
  input: SalesEnquiry,
  template: ({ data }) => [
    blocks.paragraph('mail.contactSales.body', { plan: data.plan, currency: data.currency }),
    blocks.paragraph('mail.contactSales.quote', { message: data.message }),
    blocks.paragraph('mail.signoff'),
  ],
});
