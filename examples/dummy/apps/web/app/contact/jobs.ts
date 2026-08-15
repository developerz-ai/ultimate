/**
 * The contact form's durable half. The action answers the visitor the moment the enquiry parses;
 * the receipt is a separate attempt with its own retries, so a mail provider having a bad minute
 * never turns a submitted form into an error the visitor can do nothing about.
 *
 * `t` comes from @ultimat3/jobs, not @ultimat3/schema: a job file imports one package.
 */

import { job, t } from '@ultimat3/jobs';
import { send } from '@ultimat3/mail';
import { salesReceiptEmail } from './mail';

export const sendSalesReceipt = job({
  // The locale rides in the payload rather than being read off a request: the worker renders this
  // mail minutes later, in a process that never saw the form.
  input: t.object({
    email: t.email,
    plan: t.string,
    currency: t.string,
    message: t.string,
    locale: t.locale,
  }),
  /**
   * One receipt per address per message, so a double-clicked submit is one mail. The message is
   * hashed rather than embedded: a key is an index value, and a 2,000-character body in it is a
   * row nobody can read and an index nobody can use.
   */
  idempotencyKey: ({ email, message }) =>
    `sales-receipt:${email}:${Bun.hash(message).toString(36)}`,
  retry: { attempts: 3, backoff: 'exponential' },
  queue: 'mail',
  async run({ input, step }) {
    const enquiry = {
      email: input.email,
      plan: input.plan,
      currency: input.currency,
      message: input.message,
    };
    await step.run('receipt', () =>
      send(salesReceiptEmail, enquiry, { to: input.email, locale: input.locale }),
    );
  },
});
