/**
 * Org lifecycle mail. Rendered in the `worker` role, in the recipient's locale — which is why
 * the catalogs live in a package and not in a component.
 */

import { defineMail } from '@ultimat3/core';
import type { MemberView, OrgView } from './entity';

export const welcomeEmail = defineMail<OrgView>('org.welcome', {
  subject: ({ t, data }) => t('mail.welcome.subject', { org: data.name }),
  body: ({ t, data }) => [
    t('mail.greeting', { name: data.name }),
    t('mail.welcome.body'),
    t('mail.signoff'),
  ],
  cta: ({ t }) => ({ label: t('mail.welcome.cta'), href: '/feed' }),
});

/** Sent three days later by `onboardOrg`, and only if the step has not already run. */
export const nudgeEmail = defineMail<OrgView>('org.nudge', {
  subject: ({ t, data }) => t('mail.nudge.subject', { org: data.name }),
  body: ({ t, data }) => [
    t('mail.greeting', { name: data.name }),
    t('mail.nudge.body', { org: data.name }),
    t('mail.signoff'),
  ],
  cta: ({ t }) => ({ label: t('mail.nudge.cta'), href: '/feed' }),
});

export const inviteEmail = defineMail<MemberView>('org.invite', {
  subject: ({ t, data }) => t('mail.invite.subject', { inviter: data.name, org: data.orgId }),
  body: ({ t, data }) => [
    t('mail.greeting', { name: data.name }),
    t('mail.invite.body', { role: t(`orgs.roles.${data.role}`) }),
    t('mail.signoff'),
  ],
  cta: ({ t }) => ({ label: t('mail.invite.cta'), href: '/feed' }),
});
