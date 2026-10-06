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

import { posts, tag } from '@postly/db';
import { POST_STATUSES, postId as toPostId } from '@postly/domain';
import { mutator, t, transition } from '@ultimat3/action';
import { PostView } from './entity';
import { likePostLocally } from './like-mutation';
import { postLike, postSchedule } from './policy';
import { postStatus } from './repo';

export const likePost = mutator({
  input: t.object({ postId: t.uuid, orgId: t.uuid }),
  output: PostView,
  policy: postLike,
  idempotent: true,
  cache: { invalidates: [tag.post, tag.feed] },
  mcp: { expose: true, description: 'Like a post on behalf of the acting member' },
  local: likePostLocally,
  async server(ctx, { postId }) {
    return ctx.posts.like(toPostId(postId));
  },
  conflict: 'server-wins', // | 'last-write-wins' | custom(merge)
});

/** The states a caller may move a post between here — every one except the terminal `published`. */
const SCHEDULABLE = POST_STATUSES.filter((status) => status !== 'published') as [
  'draft' | 'scheduled',
  ...('draft' | 'scheduled')[],
];

/**
 * Scheduling a draft, or taking it back — `transition()` over `posts.status`'s declared machine, so
 * a move is ONE compare-and-set statement: `from` rides in the UPDATE's predicate, and two editors
 * moving one post at once leave one winner and one `X_STATE_CONFLICT` naming the state it is in.
 *
 * `states` lists the two this mutator may name, a SUBSET of the machine: `published` is reached only
 * by `publishPost`, which stamps `publishedAt` in the same write, so asking for it here is
 * `X_INPUT_INVALID` before any statement. Optimistic like every mutator — the twin moves the
 * record's `status` at once — and `server-wins`, which the factory fixes: the server is the half
 * that refuses a move.
 */
export const movePostStatus = transition({
  table: () => postStatus,
  column: 'status',
  states: SCHEDULABLE,
  localTable: 'posts',
  output: posts.$view(['id', 'orgId', 'status', 'updatedAt']),
  policy: postSchedule,
});
