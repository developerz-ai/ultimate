/**
 * Liking a post. A `mutator` rather than an `action` because it must work in a tunnel: `local`
 * runs against the durable client store immediately, `server` is authoritative, and `conflict`
 * says who wins when they disagree.
 *
 * `local` is replayed on every rebase, so it must stay a pure function of (tx, input):
 * no I/O, no `Date.now()`, no `Math.random()`.
 *
 * `t` comes from @ultimat3/action, not @ultimat3/schema: a mutator file imports one package.
 */

import { tag } from '@postly/db';
import { postId as toPostId } from '@postly/domain';
import { mutator, t } from '@ultimat3/action';
import { PostView } from './entity';
import { postLike } from './policy';

/**
 * The local twin's row shape, named so `tx.posts` is typed on the client. The key is the entity's
 * table, which is what keeps the optimistic row and the server row in one place instead of two.
 */
declare module '@ultimat3/action' {
  interface LocalTables {
    posts: { readonly id: string; readonly likeCount: number };
  }
}

export const toggleLike = mutator({
  input: t.object({ postId: t.uuid, orgId: t.uuid }),
  output: PostView,
  policy: postLike,
  cache: { invalidates: [tag.post, tag.feed] },
  mcp: { expose: true, description: 'Like a post on behalf of the acting member' },
  local(tx, { postId }) {
    tx.posts.update(postId, (post) => ({ likeCount: post.likeCount + 1 }));
  },
  async server(ctx, { postId }) {
    return ctx.posts.like(toPostId(postId));
  },
  conflict: 'server-wins', // | 'last-write-wins' | custom(merge)
});
