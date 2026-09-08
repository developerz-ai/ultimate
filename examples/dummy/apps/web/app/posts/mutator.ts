/**
 * Liking a post. A `mutator` rather than an `action` because it must work in a tunnel: `local`
 * runs against the durable client store immediately, `server` is authoritative, and `conflict`
 * says who wins when they disagree.
 *
 * `local` is replayed on every rebase, so it must stay a pure function of (tx, input):
 * no I/O, no `Date.now()`, no `Math.random()`. Its body — and the `LocalTables` row shape it
 * writes — live in `../like-mutation.ts`, because that is the module a BROWSER can load: an island
 * cannot import this file (it drags `@ultimat3/action`, the policy and the Postgres client into the
 * chunk), and a twin declared in both places is two declarations of one intent. One import, one
 * copy, and `likePostLocally` is what actually runs on both sides.
 *
 * `t` comes from @ultimat3/action, not @ultimat3/schema: a mutator file imports one package.
 */

import { tag } from '@postly/db';
import { postId as toPostId } from '@postly/domain';
import { mutator, t } from '@ultimat3/action';
import { PostView } from './entity';
import { likePostLocally } from './like-mutation';
import { postLike } from './policy';

export const likePost = mutator({
  input: t.object({ postId: t.uuid, orgId: t.uuid }),
  output: PostView,
  policy: postLike,
  cache: { invalidates: [tag.post, tag.feed] },
  mcp: { expose: true, description: 'Like a post on behalf of the acting member' },
  local: likePostLocally,
  async server(ctx, { postId }) {
    return ctx.posts.like(toPostId(postId));
  },
  conflict: 'server-wins', // | 'last-write-wins' | custom(merge)
});
