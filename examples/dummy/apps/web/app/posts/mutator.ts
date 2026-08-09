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
 *
 * `likedByMe` is what makes the twin replayable. It is per-device state about the acting member,
 * not a column on `posts` — the server's authoritative row is the `likes` composite key, and this
 * is the local projection of "I have already applied my like to this row".
 */
declare module '@ultimat3/action' {
  interface LocalTables {
    posts: { readonly id: string; readonly likeCount: number; readonly likedByMe: boolean };
  }
}

export const likePost = mutator({
  input: t.object({ postId: t.uuid, orgId: t.uuid }),
  output: PostView,
  policy: postLike,
  cache: { invalidates: [tag.post, tag.feed] },
  mcp: { expose: true, description: 'Like a post on behalf of the acting member' },
  // Convergent, not incremental. `likeCount + 1` read the row it was about to overwrite, so every
  // rebase raised the count again and a device that replayed the queue three times showed three
  // likes for one member. Deriving the count from `likedByMe` makes applying this N times equal to
  // applying it once — which is the actual contract of `local`, since it is replayed on every
  // rebase, not the weaker "no I/O, no clock, no randomness".
  //
  // The server half converges the same way and always did: `insertLike` is insert-or-ignore on the
  // likes composite key, and `recountLikes` recounts from that table rather than adding to a
  // counter — so replaying the mutation server-side is a no-op too, and the two halves agree.
  local(tx, { postId }) {
    tx.posts.update(postId, (post) =>
      post.likedByMe ? {} : { likedByMe: true, likeCount: post.likeCount + 1 },
    );
  },
  async server(ctx, { postId }) {
    return ctx.posts.like(toPostId(postId));
  },
  conflict: 'server-wins', // | 'last-write-wins' | custom(merge)
});
