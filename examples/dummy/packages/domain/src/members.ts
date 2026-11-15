/**
 * What an erased member's `name` holds: a stored placeholder, never shown. A member's erasure keeps
 * the row (the org's posts still name their author), so every surface that renders a name asks
 * `isErasedMember` and renders the catalog's "former member" label in its place.
 */

/** Non-empty: `MemberView.name` is `t.string`, which refuses `''` on every read of the row. */
export const ERASED_MEMBER_NAME = 'erased';

export const isErasedMember = (name: string): boolean => name === ERASED_MEMBER_NAME;
