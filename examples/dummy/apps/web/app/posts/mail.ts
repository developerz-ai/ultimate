/**
 * Mail the posts feature sends. A template is a declaration: the runtime renders it in the
 * recipient's locale, in the `worker` role, with no DOM and no request in scope.
 *
 * `t` comes from @ultimat3/mail, not @ultimat3/schema: a mail file imports one package.
 */

import { blocks, defineMail, type Infer, t } from '@ultimat3/mail';
import { MemberView } from '../orgs/entity';
import { PostView } from './entity';

export const PostPublishedData = t.object({ post: PostView, member: MemberView });

export type PostPublishedData = Infer<typeof PostPublishedData>;

export const postPublished = defineMail<PostPublishedData>({
  id: 'post.published',
  subject: 'mail.postPublished.subject',
  input: PostPublishedData,
  template: ({ data }) => [
    blocks.heading('mail.greeting', { name: data.member.name }),
    blocks.paragraph('mail.postPublished.body', {
      author: data.post.authorName,
      org: data.member.orgId,
    }),
    blocks.button('mail.postPublished.cta', `/posts/${data.post.id}`),
    blocks.paragraph('mail.signoff'),
  ],
});
