// The friends screen's read model: two directional queries and one block query, joined to names and
// partitioned by status. Built here rather than in the page so the shape the UI renders is testable
// without a renderer, and so the page stays free of `db`.

import type { Friendship } from './repo';
import { blocksBy, inbox, outbox, peopleByIds } from './repo';

export interface PersonView {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
}

/** One rendered relationship. `theyAsked` is the direction, kept because the row keeps it. */
export interface EdgeView {
  readonly person: PersonView;
  readonly theyAsked: boolean;
  readonly at: Date;
}

export interface FriendsScreen {
  readonly incoming: readonly EdgeView[];
  readonly outgoing: readonly EdgeView[];
  readonly friends: readonly EdgeView[];
  readonly declined: readonly EdgeView[];
  readonly blocked: readonly EdgeView[];
}

interface Edge {
  readonly other: string;
  readonly theyAsked: boolean;
  readonly row: Friendship;
}

const newestFirst = (left: EdgeView, right: EdgeView): number =>
  right.at.getTime() - left.at.getTime();

/**
 * Everything one signed-in person's screen shows.
 *
 * Three reads, never one per row: a screen that resolves a name per relationship is a screen that
 * gets slower as the account gets more popular, which is the shape of every social-graph N+1.
 */
export const friendsScreen = async (viewerId: string): Promise<FriendsScreen> => {
  const [received, sent, blocks] = await Promise.all([
    inbox(viewerId),
    outbox(viewerId),
    blocksBy(viewerId),
  ]);

  // Normalised once. Every list below asks "who is the other person and did they ask" — deriving
  // that at each call site is how an inbox ends up rendering the viewer's own name.
  const edges: readonly Edge[] = [
    ...received.map((row) => ({ other: row.requesterId, theyAsked: true, row })),
    ...sent.map((row) => ({ other: row.addresseeId, theyAsked: false, row })),
  ];

  const people = await peopleByIds([
    ...edges.map((edge) => edge.other),
    ...blocks.map((b) => b.blockedId),
  ]);

  /** A row whose person is gone (hard-deleted, suspended out of view) renders as nothing at all. */
  const viewOf = (id: string, theyAsked: boolean, at: Date): EdgeView | null => {
    const person = people.get(id);
    if (person === undefined) return null;
    return {
      person: { id: person.id, handle: person.handle, displayName: person.displayName },
      theyAsked,
      at,
    };
  };

  const withStatus = (status: Friendship['status'], asked: boolean | null): readonly EdgeView[] =>
    edges
      .filter((edge) => edge.row.status === status && (asked === null || edge.theyAsked === asked))
      .map((edge) =>
        viewOf(
          edge.other,
          edge.theyAsked,
          // Pending rows are dated by the ask; answered rows by the answer. `respondedAt` is
          // non-null for those by invariant, and the fallback is a type narrowing, not a guess.
          status === 'pending' ? edge.row.createdAt : (edge.row.respondedAt ?? edge.row.createdAt),
        ),
      )
      .filter((view): view is EdgeView => view !== null)
      .sort(newestFirst);

  return {
    incoming: withStatus('pending', true),
    outgoing: withStatus('pending', false),
    friends: withStatus('accepted', null),
    declined: withStatus('declined', null),
    blocked: blocks
      .map((block) => viewOf(block.blockedId, false, block.createdAt))
      .filter((view): view is EdgeView => view !== null)
      .sort(newestFirst),
  };
};
