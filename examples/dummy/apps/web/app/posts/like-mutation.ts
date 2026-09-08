/**
 * `likePost`, as the BROWSER can name and APPLY it — the same seam `app/feed/live.ts` is for
 * `liveFeed`, one step further along.
 *
 * An island cannot import `./mutator.ts`: the declaration reaches `@ultimat3/action`, the policy,
 * `@postly/db`'s tag table and through it the Postgres client, none of which belong in a chunk a
 * browser downloads. `useMutation` takes anything carrying a `name`, so the name crosses and the
 * declaration never does.
 *
 * A rename is still a compile error, which is why the name is typed rather than written as a bare
 * string: a mutator IS an action, so `defineApi` registers it in `Api['actions']` under its export
 * name, and `Api` is imported as a TYPE — no module edge exists.
 *
 * **The local twin lives HERE, and `mutator.ts` imports it.** It used to live in `mutator.ts` and
 * this file said a twin here "would be a second copy" — true, and it had the direction backwards:
 * `local` is browser code by definition (it runs against the client's store, in the tab, on every
 * rebase), and the only module of this feature a browser can load is this one. So the twin's one
 * home is the browser-reachable file and the server declaration reads it, which is one declaration
 * rather than two. Every import below is `import type`, erased by `verbatimModuleSyntax`, so this
 * file still contributes nothing but its own bytes to the island's chunk.
 */

import type { LocalTx } from '@ultimat3/action';
import type { MutatorLike } from '@ultimat3/realtime';
import type { Api } from '../../api';

/**
 * The local twin's row shape, keyed by the entity's TABLE — which is what makes the optimistic row
 * and the row a live query renders one row rather than two (`IdentityMap` is keyed by that name).
 *
 * `likedByMe` is what makes the twin replayable. It is per-device state about the acting member,
 * not a column on `posts` — the server's authoritative row is the `likes` composite key, and this
 * is the local projection of "this device has already applied my like to this row". A page load is
 * a device that has applied none, so it seeds `false`; a member who liked in an earlier session and
 * likes again therefore sees a +1 this device cannot know is redundant, until the server's own row
 * lands on the next `rebase` frame. Closing that needs `likedByMe` on the post VIEW, which is a
 * change to what `postById` answers rather than anything this file can decide.
 */
declare module '@ultimat3/action' {
  interface LocalTables {
    posts: { readonly id: string; readonly likeCount: number; readonly likedByMe: boolean };
  }
}

/** Exactly the fields the twin reads. The mutator's own input is wider; this half needs the id. */
export interface LikeLocalInput {
  readonly postId: string;
}

/**
 * The optimistic half of `likePost`, and the one copy of it.
 *
 * Convergent, not incremental. `likeCount + 1` read the row it was about to overwrite, so every
 * rebase raised the count again and a device that replayed the queue three times showed three likes
 * for one member. Deriving the count from `likedByMe` makes applying this N times equal to applying
 * it once — which is the actual contract of `local`, since it is replayed on every rebase, not the
 * weaker "no I/O, no clock, no randomness". Those hold too, and for the same reason: a replay that
 * read the clock would produce a different row every time and the rebase would never converge.
 *
 * The server half converges the same way and always did: `insertLike` is insert-or-ignore on the
 * likes composite key, and `recountLikes` recounts from that table rather than adding to a counter
 * — so replaying the mutation server-side is a no-op too, and the two halves agree.
 */
export function likePostLocally(tx: LocalTx, { postId }: LikeLocalInput): void {
  tx.posts.update(postId, (post) =>
    post.likedByMe ? {} : { likedByMe: true, likeCount: post.likeCount + 1 },
  );
}

/**
 * What `useMutation` queues under. `defineApi` names a mutator after its export, so `name` is it.
 *
 * `entity` is the TABLE the twin writes, which is what a `rebase` frame's server truth lands
 * against, and `conflict` is the same `'server-wins'` the declaration carries — a client that
 * announced a different strategy would resolve the same disagreement two ways.
 */
export const LIKE_POST: MutatorLike = {
  name: 'likePost' satisfies keyof Api['actions'],
  entity: 'posts',
  conflict: 'server-wins',
  local: likePostLocally,
};
