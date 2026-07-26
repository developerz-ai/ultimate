// Single responsibility: the password-reset mail. The "you did not ask for this" line is not
// optional politeness — it is how a targeted reset attempt gets reported.

import { type Infer, t } from '@ultimat3/schema';
import { blocks } from '../blocks';
import { defineMail } from '../mail';

export const resetPasswordInput = t.object({
  name: t.string,
  url: t.url,
  expiresMinutes: t.number.int().min(1),
});

export type ResetPasswordInput = Infer<typeof resetPasswordInput>;

export const resetPasswordMail = defineMail<ResetPasswordInput>({
  id: 'reset-password',
  subject: 'mail.reset-password.subject',
  input: resetPasswordInput,
  template: ({ data }) => [
    blocks.heading('mail.reset-password.heading', { name: data.name }),
    blocks.paragraph('mail.reset-password.body'),
    blocks.button('mail.reset-password.cta', data.url),
    blocks.paragraph('mail.reset-password.expiry', { count: data.expiresMinutes }),
    blocks.paragraph('mail.reset-password.ignore'),
  ],
});
