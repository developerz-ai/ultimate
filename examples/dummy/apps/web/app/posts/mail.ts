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

/**
 * "Someone commented on your post" — what `commentPosted` (`./jobs/comment-posted.ts`) mails the author.
 * Names, not ids, in the slots: the payload is rendered on the worker with no request to look a
 * name up through, so the comment's action puts the two names in at enqueue.
 */
export const CommentPostedData = t.object({
  postId: t.uuid,
  title: t.string,
  commenter: t.string,
});

export type CommentPostedData = Infer<typeof CommentPostedData>;

export const commentPostedMail = defineMail<CommentPostedData>({
  id: 'post.commented',
  subject: 'mail.commentPosted.subject',
  input: CommentPostedData,
  template: ({ data }) => [
    blocks.paragraph('mail.commentPosted.body', { commenter: data.commenter }),
    blocks.button('mail.commentPosted.cta', `/posts/${data.postId}`),
    blocks.paragraph('mail.signoff'),
  ],
});
