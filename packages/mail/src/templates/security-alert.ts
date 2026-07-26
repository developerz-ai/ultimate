// Single responsibility: the security-alert mail — the one transactional mail that is allowed
// to alarm. Event, IP and time are rendered as details, never woven into a sentence, so they
// survive translation intact.

import { type Infer, t } from '@ultimat3/schema';
import { formatDateTime, instant } from '@ultimat3/time';
import { blocks } from '../blocks';
import { defineMail } from '../mail';

export const securityAlertInput = t.object({
  name: t.string,
  /** A machine event id (`session.new-device`), not prose. */
  event: t.string,
  ip: t.string,
  at: t.date,
});

export type SecurityAlertInput = Infer<typeof securityAlertInput>;

export const securityAlertMail = defineMail<SecurityAlertInput>({
  id: 'security-alert',
  subject: 'mail.security-alert.subject',
  input: securityAlertInput,
  template: ({ data, locale, tz }) => [
    blocks.heading('mail.security-alert.heading', { name: data.name }),
    blocks.callout('mail.security-alert.alert', 'danger'),
    blocks.detail('mail.security-alert.event-label', data.event),
    blocks.detail('mail.security-alert.ip-label', data.ip),
    blocks.detail(
      'mail.security-alert.at-label',
      formatDateTime(instant(data.at), { locale, zone: tz, style: 'medium' }),
    ),
    blocks.divider(),
    blocks.paragraph('mail.security-alert.help'),
  ],
});
