/**
 * Mail the posts feature sends. A template is a declaration: the runtime renders it in the
 * recipient's locale, in the `worker` role, with no DOM and no request in scope.
 *
 * `t` comes from @ultimat3/mail, not @ultimat3/schema: a mail file imports one package.
 */

import { blocks, defineMail, type Infer, t } from '@ultimat3/mail';
import { MemberView } from '../orgs/entity';
import { PostView } from './entity';

/**
 * `org` is the org's NAME, and it is a top-level string rather than a field reached for through
 * `member`: `{org}` is a name slot, a UUID in it is what this field exists to prevent, and the
 * SUBJECT interpolates from the payload's own top level — `renderMail` reads scalars there and
 * nowhere else, so a name nested one level deeper renders as `⟦org⟧` in the inbox.
 */
export const PostPublishedData = t.object({
  post: PostView,
  member: MemberView,
  org: t.string,
});

export type PostPublishedData = Infer<typeof PostPublishedData>;

export const postPublished = defineMail<PostPublishedData>({
  id: 'post.published',
  subject: 'mail.postPublished.subject',
  input: PostPublishedData,
  template: ({ data }) => [
    blocks.heading('mail.greeting', { name: data.member.name }),
    blocks.paragraph('mail.postPublished.body', { author: data.post.authorName, org: data.org }),
    blocks.button('mail.postPublished.cta', `/posts/${data.post.id}`),
    blocks.paragraph('mail.signoff'),
  ],
});
