// The social vocabulary: the closed sets the schema, the policies and the UI all agree on, plus the
// predicates that decide things. Pure functions only — a policy predicate is synchronous, so
// anything it calls must be too.

export const USER_ROLES = ['member', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Who a post is for. The ordering is deliberate: widest first, so a reader sees the ladder. */
export const AUDIENCES = ['public', 'friends', 'private'] as const;
export type Audience = (typeof AUDIENCES)[number];

export const FRIENDSHIP_STATUSES = ['pending', 'accepted', 'declined'] as const;
export type FriendshipStatus = (typeof FRIENDSHIP_STATUSES)[number];

export const MEDIA_KINDS = ['image', 'video'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * `pending` is the gap between "the client asked for an upload URL" and "the bytes arrived and were
 * attached to a post". A row that never leaves `pending` is an orphan, and the hourly sweep is what
 * collects it — which is only possible because the state is a column rather than an inference.
 */
export const MEDIA_STATES = ['pending', 'attached', 'orphan'] as const;
export type MediaState = (typeof MEDIA_STATES)[number];

export const BODY_MAX = 5000;

/** Admins moderate; members do not. One place, so the UI and the policy cannot disagree. */
export const canModerate = (role: UserRole): boolean => role === 'admin';

/**
 * Can a viewer in this relationship see a post with this audience? Deliberately NOT the whole
 * visibility rule — blocks and authorship are decided by the policy, which has the actor. This is
 * only the audience ladder, extracted so it is testable without an actor and impossible to spell
 * two different ways in two policies.
 */
export const isVisibleAudience = (audience: Audience, isFriend: boolean): boolean => {
  if (audience === 'public') return true;
  if (audience === 'friends') return isFriend;
  return false;
};

/**
 * A friendship that has been answered must record when.
 *
 * The CHECK is declared in `friendships.ts` as `iff(c.status.eq('pending'), c.respondedAt.isNull())`
 * and not from this function: a JS predicate cannot be translated and reports `sql: null`, so
 * passing it to `c.satisfies` claimed a constraint the database never had. This stays as the
 * app-side spelling of the same rule.
 */
export const hasRespondedCoherently = (
  status: FriendshipStatus,
  respondedAt: Date | null,
): boolean => (status === 'pending') === (respondedAt === null);
