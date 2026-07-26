/**
 * Liking a post. A `mutator` rather than an `action` because it must work in a tunnel: `local`
 * runs against the durable client store immediately, `server` is authoritative, and `conflict`
 * says who wins when they disagree.
 *
 * `local` is replayed on every rebase, so it must stay a pure function of (tx, input):
 * no I/O, no `Date.now()`, no `Math.random()`.
 */

import { tag } from '@postly/db';
import { mutator } from '@ultimat3/action';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';

export const toggleLike = mutator({
  input: t.object({ postId: t.uuid }),
  policy: can('post:like'),
  cache: { invalidates: [tag.post, tag.feed] },
  mcp: { expose: true, description: 'Like a post on behalf of the acting member' },
  local(tx, { postId }) {
    tx.posts.update(postId, (p) => ({ likes: p.likes + 1 }));
  },
  async server(ctx, { postId }) {
    return ctx.posts.like(postId);
  },
  conflict: 'server-wins', // | 'last-write-wins' | custom(merge)
});
