// Authorization for notifications. A notification is addressed to exactly one person, so the rule
// is ownership and nothing else — no audience ladder, no friendship, no block.
//
// Both rules decide on INPUT alone, and that is forced rather than chosen. `MutatorDef`
// (packages/action/src/mutator.ts:66) carries no `row` loader — `mutator()` builds its `ActionDef`
// from input/output/policy/cache/mcp/idempotent and drops anything else — so a mutator's policy can
// never be handed a row, and a row-level rule attached to one would deny every call from
// `row === null`. Ownership is therefore enforced where a mutator CAN enforce it: every write is
// scoped by `userId` in `repo.markRead`, so an id belonging to somebody else is not found and not
// written. That is one decision plus a scoped write, never a second authz path.

import { can, definePermissions } from '@ultimat3/policy';

declare module '@ultimat3/policy' {
  interface PermissionRegistry {
    'notification:read': true;
    'notification:mark-read': true;
  }
}

export const notificationPermissions = definePermissions([
  'notification:read',
  'notification:mark-read',
]);

/**
 * Your own inbox. There is no surface that takes a notification id and reads it back, so there is
 * no row for a rule to decide about — the page reads `inboxFor(actor.id)` and the scope IS the
 * actor. A row-level predicate here would be a rule with nothing to run on.
 */
export const notificationRead = can('notification:read');

/** Same shape, same reason. The batch's effect is bounded by the actor, not by the rule. */
export const notificationMarkRead = can('notification:mark-read');
