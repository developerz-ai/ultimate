/**
 * Mail the posts feature sends. A template is a declaration: the runtime renders it in the
 * recipient's locale, in the `worker` role, with no DOM and no request in scope.
 */

import type { Member } from '@postly/db';
import { defineMail } from '@ultimat3/core';
import type { PostView } from './entity';

type PostPublishedData = { post: PostView; member: Member };

export const postPublished = defineMail<PostPublishedData>('post.published', {
  subject: ({ t, data }) =>
    t('mail.postPublished.subject', { title: data.post.title, org: data.member.orgId }),
  body: ({ t, data }) => [
    t('mail.greeting', { name: data.member.name }),
    t('mail.postPublished.body', { author: data.post.authorName, org: data.member.orgId }),
    t('mail.signoff'),
  ],
  cta: ({ t, data }) => ({
    label: t('mail.postPublished.cta'),
    href: `/posts/${data.post.id}`,
  }),
});
