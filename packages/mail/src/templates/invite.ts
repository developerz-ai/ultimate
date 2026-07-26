// Single responsibility: the org-invitation mail.

import { type Infer, t } from '@ultimat3/schema';
import { blocks } from '../blocks';
import { defineMail } from '../mail';

export const inviteInput = t.object({
  inviterName: t.string,
  orgName: t.string,
  url: t.url,
  expiresHours: t.number.int().min(1),
});

export type InviteInput = Infer<typeof inviteInput>;

export const inviteMail = defineMail<InviteInput>({
  id: 'invite',
  subject: 'mail.invite.subject',
  input: inviteInput,
  template: ({ data }) => [
    blocks.heading('mail.invite.heading', { orgName: data.orgName }),
    blocks.paragraph('mail.invite.body', {
      inviterName: data.inviterName,
      orgName: data.orgName,
    }),
    blocks.button('mail.invite.cta', data.url),
    blocks.paragraph('mail.invite.expiry', { count: data.expiresHours }),
  ],
});
