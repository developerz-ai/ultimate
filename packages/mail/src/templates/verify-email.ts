// Single responsibility: the email-verification mail. The expiry line is a plural key, so a
// 1-minute link never reads "1 minutes".

import { type Infer, t } from '@ultimat3/schema';
import { blocks } from '../blocks';
import { defineMail } from '../mail';

export const verifyEmailInput = t.object({
  name: t.string,
  url: t.url,
  expiresMinutes: t.number.int().min(1),
});

export type VerifyEmailInput = Infer<typeof verifyEmailInput>;

export const verifyEmailMail = defineMail<VerifyEmailInput>({
  id: 'verify-email',
  subject: 'mail.verify-email.subject',
  input: verifyEmailInput,
  template: ({ data }) => [
    blocks.heading('mail.verify-email.heading', { name: data.name }),
    blocks.paragraph('mail.verify-email.body'),
    blocks.button('mail.verify-email.cta', data.url),
    blocks.paragraph('mail.verify-email.expiry', { count: data.expiresMinutes }),
    blocks.paragraph('mail.verify-email.ignore'),
  ],
});
