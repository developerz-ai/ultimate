// The public feed's read, composed from the repo. The page's `load` calls this; it never calls the
// repo and it never sees `db`. Under `site/feed/` beside the one page that reads it, the way
// `site/u/service.ts` sits beside the profile: it lived in `app/posts/`, and the static page
// reaching for it was X_BOUNDARY_SITE_TO_APP, dragging `app/`'s policy module across the line.
//
// Visibility is decided by `canSeePost`, run over every row read. The read itself asks the database
// for the rows that rule admits THIS viewer — `visibleTo`, the rule's SQL projection as one tree —
// so the page is exact: the rule stays the authority and the tree only keeps the page full.

import { actorFact } from '@ultimat3/core';
import type { PredicateNode } from '@ultimat3/entity';
import { type Actor, isSignedIn } from '../../shared/actor';
import { canSeePost } from '../../shared/visibility';
import { authorsByIds, type FeedPost, feedPage } from './repo';

/** What a rendered feed row needs. Derived from the post; the author is joined in by name. */
export interface FeedItem {
  readonly post: FeedPost;
  readonly authorHandle: string;
  readonly authorName: string;
}

/**
 * The feed a viewer may see, newest first — the filter, over rows somebody else read.
 *
 * Synchronous and pure on purpose: `canSeePost` is the rule, and a rule that can be handed a page
 * and an author lookup is a rule a test can drive with neither a database nor a renderer.
 */
export const visibleFeed = (
  viewer: Actor | null,
  limit: number,
  authorOf: (id: string) => { handle: string; displayName: string } | undefined,
  rows: readonly FeedPost[],
): readonly FeedItem[] => {
  const items: FeedItem[] = [];
  for (const post of rows) {
    if (items.length >= limit) break;
    if (!canSeePost(viewer, post)) continue;
    const author = authorOf(post.authorId);
    if (author === undefined) continue;
    items.push({ post, authorHandle: author.handle, authorName: author.displayName });
  }
  return items;
};

/**
 * Blocked authors excluded IN the statement, at most this many; past it the rest are excluded by
 * `canSeePost` over the rows read, so a viewer with more blocks than this can get a short page.
 * An exclusion is a parameter per id — the tree has no `not in (select …)` to hop it into
 * `blocks` — and Postgres binds at most 65,535 per statement. Friends cost none: they are a hop.
 */
export const MAX_BLOCKS_IN_STATEMENT = 1_000;

/** "A friend of `viewerId`": an accepted friendship in either direction, read where it is stored. */
const friendOf = (viewerId: string, mine: 'requesterId' | 'addresseeId') => {
  const theirs = mine === 'requesterId' ? 'addresseeId' : 'requesterId';
  return {
    via: { column: 'authorId' as const, entity: 'friendships', target: theirs },
    where: [
      { column: mine, op: 'eq' as const, value: viewerId },
      { column: 'status', op: 'eq' as const, value: 'accepted' },
    ],
  };
};

/**
 * `canSeePost` for `viewer`, as the predicates the database serves — deleted rows are the read's own
 * `where`, and the rest is the rule in its own order. A block beats everything: each blocked author
 * is excluded first, both directions already unioned into the actor's set. Then the author
 * themself, a public post, or a friends-only post by an accepted friend — a hop into `friendships`,
 * so a viewer with 70,000 friends binds no more than one with a single friend. Anonymous is the
 * ladder's `public`.
 */
export const visibleTo = (viewer: Actor | null): readonly PredicateNode<FeedPost>[] => {
  if (!isSignedIn(viewer)) return [{ column: 'audience', op: 'eq', value: 'public' }];
  const blocked = [...(actorFact(viewer, 'blockedIds') ?? [])].slice(0, MAX_BLOCKS_IN_STATEMENT);
  const friendsOnly = { column: 'audience' as const, op: 'eq' as const, value: 'friends' };
  return [
    ...blocked.map((id) => ({ column: 'authorId' as const, op: 'neq' as const, value: id })),
    {
      or: [
        { column: 'authorId', op: 'eq', value: viewer.id },
        { column: 'audience', op: 'eq', value: 'public' },
        { and: [friendsOnly, friendOf(viewer.id, 'requesterId')] },
        { and: [friendsOnly, friendOf(viewer.id, 'addresseeId')] },
      ],
    },
  ];
};

/**
 * The feed a page renders: two statements, in this order, and the order is the point. The page is
 * read first so the author lookup can name the ids that page actually holds — the read this
 * replaced asked for "some 200 users" before it knew which ones it needed.
 *
 * It wraps `visibleFeed` so a ROUTE never imports `db` — a page reaching the database directly is
 * X_BOUNDARY_ROUTE_TO_DB, and it is how N+1 queries end up inside a <head> computation.
 *
 * Reads exactly `limit` rows, for any viewer. It used to read `limit * 3` and filter after, which
 * still served a short page — or none — whenever the newest hidden posts outnumbered the multiplier.
 */
export const feedForPage = async (
  viewer: Actor | null,
  limit: number,
): Promise<readonly FeedItem[]> => {
  const rows = await feedPage(limit, visibleTo(viewer));
  const authors = await authorsByIds(rows.map((post) => post.authorId));
  return visibleFeed(viewer, limit, (id) => authors.get(id), rows);
};
