/**
 * The receipt a sales enquiry earns. A visitor who typed an address into a form on an anonymous
 * page has no account and no row, so the enquiry IS the payload — there is nothing to load it
 * back from and nothing to key it by but the address the visitor gave.
 */

import { budgetText } from '@postly/domain';
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
  /** What the visitor typed as their monthly budget, already read in their locale; `null` if blank. */
  budget: t.nullable(t.money),
});

export type SalesEnquiry = Infer<typeof SalesEnquiry>;

export const salesReceiptEmail = defineMail<SalesEnquiry>({
  id: 'contact.sales-receipt',
  subject: 'mail.contactSales.subject',
  input: SalesEnquiry,
  template: ({ data, locale }) => [
    blocks.paragraph('mail.contactSales.body', { plan: data.plan, currency: data.currency }),
    blocks.paragraph('mail.contactSales.quote', { message: data.message }),
    // Written in the RECIPIENT's locale, never echoed as typed: the receipt is the reading.
    ...(data.budget === null
      ? []
      : [blocks.detail('mail.contactSales.budget', budgetText(data.budget, locale))]),
    blocks.paragraph('mail.signoff'),
  ],
  // What `x mail preview contact.sales-receipt` and the `/_x` mail panel render, in every locale.
  preview: {
    email: 'ada@example.test',
    plan: 'team',
    currency: 'EUR',
    message: 'We are twelve people and want to try the team plan.',
    budget: { minor: 120000, currency: 'EUR' },
  },
});
