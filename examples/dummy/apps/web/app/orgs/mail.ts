/**
 * Org lifecycle mail. Rendered in the `worker` role, in the recipient's locale — which is why
 * the catalogs live in a package and not in a component.
 *
 * A template is a list of blocks carrying i18n keys: no markup, no colour, no formatted date.
 * That is what lets one declaration produce both the HTML part and the text part.
 */

import { blocks, defineMail } from '@ultimat3/mail';
import { MemberView, OrgView } from './entity';

export const welcomeEmail = defineMail<OrgView>({
  id: 'org.welcome',
  subject: 'mail.welcome.subject',
  input: OrgView,
  template: ({ data }) => [
    blocks.heading('mail.greeting', { name: data.name }),
    blocks.paragraph('mail.welcome.body'),
    blocks.button('mail.welcome.cta', '/feed'),
    blocks.paragraph('mail.signoff'),
  ],
});

/** Sent three days later by `onboardOrg`, and only if the step has not already run. */
export const nudgeEmail = defineMail<OrgView>({
  id: 'org.nudge',
  subject: 'mail.nudge.subject',
  input: OrgView,
  template: ({ data }) => [
    blocks.heading('mail.greeting', { name: data.name }),
    blocks.paragraph('mail.nudge.body', { org: data.name }),
    blocks.button('mail.nudge.cta', '/feed'),
    blocks.paragraph('mail.signoff'),
  ],
});

export const inviteEmail = defineMail<MemberView>({
  id: 'org.invite',
  subject: 'mail.invite.subject',
  input: MemberView,
  template: ({ data, t }) => [
    blocks.heading('mail.greeting', { name: data.name }),
    blocks.paragraph('mail.invite.body', { role: t(`orgs.roles.${data.role}`) }),
    blocks.button('mail.invite.cta', '/feed'),
    blocks.paragraph('mail.signoff'),
  ],
});
