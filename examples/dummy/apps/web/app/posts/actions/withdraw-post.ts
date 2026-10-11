// `withdrawPost`, the posts slice's action — one primitive per file, the layout `x g` writes.
//
// Taking a published post back to a draft: the write that makes a public page come DOWN. It is why
// `site/blog/*` declares `onInvalidate: 'purge'` — under the default a bust keeps the stored page
// for one more serve, and the next reader of a withdrawn article would still be handed it.

import { tag } from '@postly/db';
import { postId } from '@postly/domain';
import { action, t } from '@ultimat3/action';
import { PostView } from '../entity';
import { postPublish } from '../policy';

export const withdrawPost = action({
  input: t.object({ postId: t.uuid, orgId: t.uuid }),
  output: PostView,
  // The publishing right decides its reverse too, on the same loaded row (`publishPost`).
  policy: postPublish,
  row: ({ input: { postId: id }, ctx }) => ctx.posts.authorship(postId(id)),
  // The same three tags `publishPost` busts: the post, the org feed, and the public blog.
  cache: { invalidates: [tag.post, tag.feed, tag.blog] },
  handle: ({ input, ctx }) => ctx.posts.withdraw(postId(input.postId)),
});
