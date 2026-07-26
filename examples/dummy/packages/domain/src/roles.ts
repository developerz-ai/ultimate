/**
 * The membership role vocabulary and its ordering. Policies compare ranks so that adding a role
 * never means hunting down string equality checks.
 */

export const MEMBER_ROLES = ['owner', 'admin', 'author', 'reader'] as const;

export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Higher rank subsumes every capability of a lower one. */
export const ROLE_RANK: Readonly<Record<MemberRole, number>> = Object.freeze({
  owner: 40,
  admin: 30,
  author: 20,
  reader: 10,
});

export const isAtLeast = (role: MemberRole, minimum: MemberRole): boolean =>
  ROLE_RANK[role] >= ROLE_RANK[minimum];

/** Who may act on another member's content or change org-level settings. */
export const isOrgAdmin = (role: MemberRole): boolean => isAtLeast(role, 'admin');

/** Who may create posts at all. Readers can comment and like, never author. */
export const canAuthor = (role: MemberRole): boolean => isAtLeast(role, 'author');
