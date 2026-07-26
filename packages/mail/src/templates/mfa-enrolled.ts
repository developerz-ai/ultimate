// Single responsibility: the "a second factor was added" notice. The enrolment time is
// formatted in the recipient's zone — "at 03:12" is only useful if it is their 03:12.

import { type Infer, t } from '@ultimat3/schema';
import { formatDateTime, instant } from '@ultimat3/time';
import { blocks } from '../blocks';
import { defineMail } from '../mail';

export const MFA_METHODS = ['totp', 'webauthn', 'sms'] as const;

export const mfaEnrolledInput = t.object({
  name: t.string,
  method: t.enum(MFA_METHODS),
  at: t.date,
});

export type MfaEnrolledInput = Infer<typeof mfaEnrolledInput>;

export const mfaEnrolledMail = defineMail<MfaEnrolledInput>({
  id: 'mfa-enrolled',
  subject: 'mail.mfa-enrolled.subject',
  input: mfaEnrolledInput,
  template: ({ data, t: translate, locale, tz }) => [
    blocks.heading('mail.mfa-enrolled.heading', { name: data.name }),
    blocks.paragraph('mail.mfa-enrolled.body'),
    blocks.detail(
      'mail.mfa-enrolled.method-label',
      translate(`mail.mfa-enrolled.method-${data.method}`),
    ),
    blocks.detail(
      'mail.mfa-enrolled.at-label',
      formatDateTime(instant(data.at), { locale, zone: tz, style: 'medium' }),
    ),
    blocks.divider(),
    blocks.paragraph('mail.mfa-enrolled.help'),
  ],
});
