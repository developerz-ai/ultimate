/**
 * The digest email. Rendered in the `worker` role with the member's locale and — the part that is
 * usually wrong — the member's timezone. `format.date` requires an explicit zone, so "yesterday"
 * means yesterday where the reader is.
 */

import { defineMail } from '@ultimat3/core';
import type { MemberView } from '../orgs/entity';
import type { PostSummary } from '../posts/entity';

type DigestData = {
  member: MemberView;
  posts: readonly PostSummary[];
  localDate: string;
};

export const digestEmail = defineMail<DigestData>('digest.daily', {
  subject: ({ t, format, data }) =>
    t('digest.subject', { date: format.date(data.localDate, { zone: data.member.tz }) }),
  body: ({ t, data }) => [
    t('digest.greeting', { name: data.member.name }),
    t('digest.intro', { count: data.posts.length, org: data.member.orgId }),
    ...data.posts.map((post) => `• ${post.title}`),
    t('digest.footer', { zone: data.member.tz }),
  ],
  cta: ({ t }) => ({ label: t('digest.readAction'), href: '/feed' }),
  footerLinks: ({ t }) => [{ label: t('digest.unsubscribe'), href: '/settings' }],
});
